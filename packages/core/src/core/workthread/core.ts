/**
 * WorkThread — 框架层「Session + 接续变换」的连续性锚点（锚点层）
 *
 * 移植自 Claw `server/thread-control/thread-controller.js` 的锚点层成员，按
 * ADR-0002/Q4=C 拆分。WorkThread 只承载连续性锚点与接续编排状态：
 *   - sessionChain / headSessionId（先后接力的 Session 认作同一项工作）
 *   - 交接挡板 pendingSuccession（beginSessionHandoff / isHandoffActive /
 *     advanceHead 换代+清挡板原子成对）
 *   - 指令暂存 Inbox（appendCommand / deliverPendingCommands / cancelCommand）
 *   - 接续编排状态（rotating / rotation_failed / failSessionHandoff(stage)）
 *   - 宿主级 hold 布尔开关（落盘第一等，重启不丢）
 *   - closeThread 锚点收口（取消 pending 指令 + terminal 判定）
 *
 * 不承载执行调度看板（看板执行状态机 / executionEvents / resume / mode）——
 * 那是可选平行模块 WorkThreadBoard（board.ts），经 workThreadId 关联，永不反写
 * 锚点状态。本模块 import 面不含任何看板状态值。
 *
 * 投递门槛只保留客观事实：closed？交接窗口 fresh？hold？bridge enabled？
 * runtime 接收就绪（注入的 resolveRuntime）。失败 / 等待输入的暂停投递由宿主
 * 经 hold 开关表达，不在此层。
 */

import type { WorkThreadStore, WorkThreadRecord } from './store.js';
import {
  WorkThreadNotFoundError,
} from './store.js';
import {
  createCommandRecord,
  appendCommand as appendCommandToRecord,
  pendingCommands,
  findCommand,
  pruneCommands,
  WorkThreadCommandStatus,
  WorkThreadCommandKind,
  type WorkThreadCommand,
} from './inbox.js';
import { WorkThreadRuntimeBridge, WORKTHREAD_BRIDGE_DISABLED_REASON } from './bridge.js';
import type { WorkThreadBridge } from './bridge.js';
import { generateWorkThreadId } from './store.js';

export { WorkThreadNotFoundError };

export const WORKTHREAD_TERMINAL_STATUS = 'closed';

/** 交接意图陈旧线：pendingSuccession 超过该时长视为已失效（compact 失败、进程
 *  崩溃等路径不会显式清除）。失效后投递自动恢复——此时 head 仍是权威值（旧会话），
 *  指令投向它即正确语义。 */
export const HANDOFF_STALE_MS = 5 * 60 * 1000;

const VALID_ID_RE = /^[\w.-]{1,200}$/;

function validateId(value: unknown, label: string): string {
  const id = String(value || '').trim();
  if (!VALID_ID_RE.test(id)) {
    throw Object.assign(new Error(`Invalid ${label}: ${JSON.stringify(String(value || ''))}`), {
      code: 'invalid_request',
      status: 400,
    });
  }
  return id;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pushLifecycleEvent(
  record: WorkThreadRecord,
  event: WorkThreadRecord['lifecycleEvents'][number],
  maxEvents = 200,
): void {
  record.lifecycleEvents = Array.isArray(record.lifecycleEvents) ? record.lifecycleEvents : [];
  record.lifecycleEvents.push(event);
  if (record.lifecycleEvents.length > maxEvents) {
    record.lifecycleEvents.splice(0, record.lifecycleEvents.length - maxEvents);
  }
  record.lastLifecycleEvent = event;
}

export interface WorkThreadStartOptions {
  sessionRef: { agentId: string; sessionId: string };
  title?: string;
  workspaceId?: string;
  /**
   * T001：显式指定线程身份归属。缺省时由 identitySource 从 root Session
   * 解析；解析不到（身份未知）时归属为 null，而不是默认成某个具体身份。
   */
  identity?: string | null;
}

export interface WorkThreadOptions {
  store: WorkThreadStore;
  bridge?: WorkThreadBridge;
  /**
   * T001：线程身份解析器（宿主注入的会话身份真相源，如 Claw 的 session
   * index）。框架不内置产品身份词汇：返回值即线程归属；空值 = 身份未知。
   */
  identitySource?: (agentId: string, sessionId: string) => Promise<string | null> | string | null;
}

function threadIdentityError(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

export class WorkThread {
  readonly store: WorkThreadStore;
  private readonly _bridge: WorkThreadBridge;
  private readonly _identitySource?: (agentId: string, sessionId: string) => Promise<string | null> | string | null;

  constructor({ store, bridge, identitySource }: WorkThreadOptions) {
    this.store = store;
    this._bridge = bridge || new WorkThreadRuntimeBridge();
    this._identitySource =
      identitySource && typeof identitySource === 'function' ? identitySource : undefined;
  }

  // ── 查询 ─────────────────────────────────────────────────────────

  async listThreads(opts: { agentId?: string } = {}): Promise<unknown[]> {
    const entries = await this.store.list();
    const normalized = cleanText(opts.agentId || '');
    return normalized ? entries.filter((t) => (t as { agentId?: string }).agentId === normalized) : entries;
  }

  async getThread(threadId: string): Promise<WorkThreadRecord | null> {
    return this.store.get(threadId);
  }

  isTerminal(record: WorkThreadRecord | null | undefined): boolean {
    return Boolean(record && record.status === WORKTHREAD_TERMINAL_STATUS);
  }

  /**
   * 按会话查线程：sessionId 是某线程的当前承接会话（head）时返回该线程。
   * 返回完整线程记录（权威真相，含 pendingSuccession / commands / hold）。
   */
  async findThreadByHeadSession(agentId: string, sessionId: string): Promise<WorkThreadRecord | null> {
    const normalizedAgentId = cleanText(agentId);
    const normalizedSessionId = cleanText(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) return null;
    const threads = await this.listThreads({ agentId: normalizedAgentId });
    const matched = threads.find(
      (t) => (t as { headSessionId?: string }).headSessionId === normalizedSessionId,
    ) as { threadId?: string } | undefined;
    if (!matched?.threadId) return null;
    return this.store.get(matched.threadId);
  }

  /**
   * 按成员查线程（T001）：sessionId 是该线程任一成员（root / predecessor /
   * head）时返回线程完整记录。成员事实唯一来自 sessionChain 链记录，
   * 不用 UI 投影或运行时扫描推导；记录上的 identity 即为该成员统一的
   * 身份归属事实（root / head / 历史成员同属一条记录，取值一致）。
   */
  async findThreadBySession(agentId: string, sessionId: string): Promise<WorkThreadRecord | null> {
    const normalizedAgentId = cleanText(agentId);
    const normalizedSessionId = cleanText(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) return null;
    const threads = await this.listThreads({ agentId: normalizedAgentId });
    for (const summary of threads as Array<{ threadId?: string }>) {
      if (!summary?.threadId) continue;
      const record = await this.store.get(summary.threadId);
      if (Array.isArray(record?.sessionChain)
        && record.sessionChain.some((entry) => entry?.sessionId === normalizedSessionId)) {
        return record;
      }
    }
    return null;
  }

  // ── 创建（显式 opt-in，Q5=B）────────────────────────────────────

  /** 解析线程身份归属（T001）：显式参数优先，否则经 identitySource 从 root
   *  Session 解析；解析不到归一为 null（身份未知，绝不默认成具体身份）。 */
  private async resolveIdentity(
    explicit: string | null | undefined,
    agentId: string,
    sessionId: string,
  ): Promise<string | null> {
    const normalizedExplicit = cleanText(explicit);
    if (explicit === null) return null;
    if (normalizedExplicit) return normalizedExplicit;
    if (!this._identitySource) return null;
    const resolved = await this._identitySource(agentId, sessionId);
    return cleanText(resolved) || null;
  }

  /**
   * 唯一创建入口：把一个既有会话认作 root 并成为初始 head。
   * 不提供「session 创建即自动建线程」的框架语义——那是宿主策略（integration 层）。
   *
   * T001：创建时从 root Session 确定线程身份归属（record.identity）。
   */
  async start({ sessionRef, title = '', workspaceId = '', identity }: WorkThreadStartOptions): Promise<WorkThreadRecord> {
    if (!sessionRef || typeof sessionRef !== 'object') {
      throw Object.assign(new Error('start requires sessionRef'), { code: 'invalid_request', status: 400 });
    }
    const agentId = validateId(sessionRef.agentId, 'agentId');
    const sessionId = validateId(sessionRef.sessionId, 'sessionId');
    const threadIdentity = await this.resolveIdentity(identity, agentId, sessionId);

    const now = Date.now();
    const record: WorkThreadRecord = {
      threadId: generateWorkThreadId(),
      agentId,
      workspaceId: cleanText(workspaceId) || agentId,
      title: cleanText(title),
      status: 'open',
      identity: threadIdentity,
      rootSessionId: sessionId,
      headSessionId: sessionId,
      sessionChain: [
        {
          sessionId,
          role: 'head',
          startedAt: now,
          endedAt: null,
          endKind: null,
          successorSessionId: null,
        },
      ],
      commands: [],
      pendingSuccession: null,
      hold: false,
      lifecycleEvents: [],
      lastLifecycleEvent: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    return this.store.create(record);
  }

  // ── 交接意图（pendingSuccession）────────────────────────────────

  /**
   * 派生：交接意图是否仍然有效（fresh）。stale 视为无交接。
   */
  isHandoffActive(record: WorkThreadRecord): boolean {
    const pending = record?.pendingSuccession;
    if (!pending?.startedAt) return false;
    return Date.now() - pending.startedAt < HANDOFF_STALE_MS;
  }

  /**
   * 标记线程进入交接：写入 pendingSuccession（幂等，重复调用刷新时间戳）。
   * 同步置 status=rotating（接续编排状态归锚点层）。
   */
  async beginSessionHandoff(opts: {
    threadId: string;
    fromSessionId: string;
    reason?: string;
  }): Promise<WorkThreadRecord> {
    const threadId = validateId(opts.threadId, 'threadId');
    const normalizedFrom = validateId(opts.fromSessionId, 'fromSessionId');
    const normalizedReason = cleanText(opts.reason) || 'manual';
    const { record } = await this.store.update(threadId, (draft) => {
      if (draft.status === WORKTHREAD_TERMINAL_STATUS) {
        throw Object.assign(new Error(`WorkThread "${threadId}" is closed`), {
          code: 'thread_closed',
          status: 409,
        });
      }
      if (draft.headSessionId !== normalizedFrom) {
        throw Object.assign(
          new Error(`Handoff source is not the current head of workthread "${threadId}"`),
          { code: 'head_mismatch', status: 409 },
        );
      }
      const now = Date.now();
      draft.status = 'rotating';
      draft.pendingSuccession = {
        fromSessionId: normalizedFrom,
        reason: normalizedReason,
        stage: 'started',
        startedAt: now,
      };
      pushLifecycleEvent(draft, {
        type: 'handoff_started',
        status: 'rotating',
        at: now,
        fromSessionId: normalizedFrom,
        reason: normalizedReason,
      });
      return draft;
    });
    return record;
  }

  /**
   * 惰性清除陈旧的交接意图（投递路径发现 stale 时恢复常态）。
   */
  private async clearStaleHandoff(threadId: string): Promise<void> {
    await this.store.update(threadId, (draft) => {
      if (!draft.pendingSuccession) return draft;
      draft.pendingSuccession = null;
      if (draft.status === 'rotating') draft.status = 'open';
      pushLifecycleEvent(draft, { type: 'handoff_stale', status: draft.status, at: Date.now() });
      return draft;
    });
  }

  /**
   * 标记交接失败为接续编排状态 rotation_failed，不折叠成通用执行失败。
   * pendingSuccession 保留在盘上，供后续 resume 检查被打断的确切 stage。
   */
  async failSessionHandoff(
    threadId: string,
    opts: { reason?: string; stage?: string; error?: unknown } = {},
  ): Promise<WorkThreadRecord> {
    const thread = await this.store.get(threadId);
    if (!thread) throw new WorkThreadNotFoundError(threadId);
    const { record } = await this.store.update(threadId, (draft) => {
      draft.status = 'rotation_failed';
      if (draft.pendingSuccession) {
        draft.pendingSuccession.stage = cleanText(opts.stage) || draft.pendingSuccession.stage || 'unknown';
      }
      pushLifecycleEvent(draft, {
        type: 'handoff_failed',
        status: 'rotation_failed',
        at: Date.now(),
        reason: cleanText(opts.reason) || 'handoff_failed',
        stage: cleanText(opts.stage) || 'unknown',
        error: opts.error != null ? String(opts.error) : null,
      });
      return draft;
    });
    return record;
  }

  // ── 指令（WorkThread Inbox）────────────────────────────────────

  /**
   * 幂等追加一条线程指令。
   * @returns {{command, duplicate, threadRevision}}
   */
  async appendCommand(opts: {
    threadId: string;
    kind?: string;
    text: string;
    source?: string;
    idempotencyKey?: string;
    capabilityActivations?: string[];
  }): Promise<{ command: WorkThreadCommand; duplicate: boolean; threadRevision: number }> {
    const threadId = validateId(opts.threadId, 'threadId');
    const normalizedKind =
      opts.kind && Object.values(WorkThreadCommandKind).includes(opts.kind as never)
        ? opts.kind
        : WorkThreadCommandKind.USER_MESSAGE;
    const normalizedText = String(opts.text || '');
    if (!normalizedText.trim()) {
      throw Object.assign(new Error('Command text must be non-empty'), {
        code: 'invalid_request',
        status: 400,
      });
    }
    if (normalizedText.length > 100_000) {
      throw Object.assign(new Error('Command text too large'), {
        code: 'invalid_request',
        status: 400,
      });
    }

    const command = createCommandRecord({
      threadId,
      kind: normalizedKind,
      text: normalizedText,
      source: cleanText(opts.source) || 'ui',
      idempotencyKey: cleanText(opts.idempotencyKey),
      ...(Array.isArray(opts.capabilityActivations) ? { capabilityActivations: opts.capabilityActivations } : {}),
    });

    let appendOutcome = { command, duplicate: false };
    const { record } = await this.store.update(threadId, (draft) => {
      appendOutcome = appendCommandToRecord(draft, command);
      pruneCommands(draft);
      return draft;
    });

    return {
      command: appendOutcome.command,
      duplicate: appendOutcome.duplicate,
      threadRevision: record.revision,
    };
  }

  /** 取消一条尚未投递的指令（pending → cancelled）。 */
  async cancelCommand(threadId: string, commandId: string): Promise<WorkThreadCommand | null> {
    const tid = validateId(threadId, 'threadId');
    const cid = validateId(commandId, 'commandId');
    const { record } = await this.store.update(tid, (draft) => {
      const command = findCommand(draft, cid);
      if (command && command.status === WorkThreadCommandStatus.PENDING) {
        command.status = WorkThreadCommandStatus.CANCELLED;
        command.updatedAt = Date.now();
      }
      return draft;
    });
    return findCommand(record, cid);
  }

  /**
   * 尝试把 pending 指令下沉到当前 head runtime。
   *
   * 投递判定（锚点层只保留客观事实）：
   *   - terminal（closed）→ thread_closed
   *   - 交接窗口 fresh（pendingSuccession 未 stale）→ handoff_in_progress
   *   - hold 开关置位 → thread_held（宿主级暂停投递）
   *   - bridge disabled → bridge_disabled
   *   - head runtime 未就绪（注入 resolveRuntime 返回 null）→ runtime_not_accepting
   *
   * @returns {{attempted, delivered, reason?, results}}
   */
  async deliverPendingCommands(threadId: string): Promise<{
    attempted: number;
    delivered: number;
    reason?: string;
    results: Array<{ commandId?: string; accepted?: boolean; reason?: string; retryable?: boolean; deliveryRef?: string }>;
  }> {
    const tid = validateId(threadId, 'threadId');

    const thread = await this.store.get(tid);
    if (!thread) throw new WorkThreadNotFoundError(tid);
    if (this.isTerminal(thread)) {
      return { attempted: 0, delivered: 0, reason: 'thread_closed', results: [] };
    }
    if (thread.hold === true) {
      return { attempted: 0, delivered: 0, reason: 'thread_held', results: [] };
    }

    // 交接进行中：指令保持 pending，等 advanceHead 后由宿主导流到新 head。
    // stale 的交接意图（失败路径残留）惰性清除后照常投递。
    if (thread.pendingSuccession) {
      if (this.isHandoffActive(thread)) {
        return { attempted: 0, delivered: 0, reason: 'handoff_in_progress', results: [] };
      }
      await this.clearStaleHandoff(tid);
    }

    const pending = pendingCommands(thread);
    if (pending.length === 0) {
      return { attempted: 0, delivered: 0, results: [] };
    }

    if (!this._bridge.isEnabled()) {
      return { attempted: 0, delivered: 0, reason: WORKTHREAD_BRIDGE_DISABLED_REASON, results: [] };
    }

    const results: Array<{
      commandId?: string;
      accepted?: boolean;
      reason?: string;
      retryable?: boolean;
      deliveryRef?: string;
    }> = [];
    let deliveredCount = 0;
    let stopReason: string | null = null;

    for (const command of pending) {
      const outcome = await this._bridge.deliver({ thread, command });
      results.push({ commandId: command.commandId, ...outcome });

      if (outcome.accepted) {
        deliveredCount += 1;
      } else if (outcome.retryable) {
        stopReason = outcome.reason || stopReason;
        break;
      }
    }

    const deliveredIds = new Set(
      results.filter((r) => r.accepted).map((r) => r.commandId as string),
    );
    const failedResults = new Map<string, string | undefined>(
      results
        .filter((r) => !r.accepted && r.retryable === false)
        .map((r) => [r.commandId as string, r.reason]),
    );

    if (deliveredIds.size > 0 || failedResults.size > 0) {
      const { record } = await this.store.update(tid, (draft) => {
        for (const c of draft.commands || []) {
          if (deliveredIds.has(c.commandId)) {
            c.status = WorkThreadCommandStatus.DELIVERED;
            c.deliveryRef = results.find((r) => r.commandId === c.commandId)?.deliveryRef || null;
            c.attempts = (Number(c.attempts) || 0) + 1;
            c.updatedAt = Date.now();
            c.deliveredAt = Date.now();
            c.lastReason = null;
          } else if (failedResults.has(c.commandId)) {
            c.status = WorkThreadCommandStatus.FAILED;
            c.lastReason = failedResults.get(c.commandId) || null;
            c.attempts = (Number(c.attempts) || 0) + 1;
            c.updatedAt = Date.now();
          }
        }
        return draft;
      });
      thread.revision = record.revision;
    }

    return {
      attempted: results.length,
      delivered: deliveredCount,
      reason: stopReason ?? undefined,
      results,
    };
  }

  /**
   * 宿主级「暂停投递」布尔开关（落盘第一等，重启不丢）。
   * @param held true 暂停投递（deliverPendingCommands 返回 thread_held）
   */
  async setHold(threadId: string, held: boolean): Promise<WorkThreadRecord> {
    const tid = validateId(threadId, 'threadId');
    const wantHold = held === true;
    const { record } = await this.store.update(tid, (draft) => {
      if (draft.hold === wantHold) return draft;
      draft.hold = wantHold;
      return draft;
    });
    return record;
  }

  // ── 会话接力（head 推进）────────────────────────────────────────

  /**
   * 推进线程 head：headSessionId: fromSessionId → toSessionId。
   *
   * 关键不变量（与 store 原子写共同保证）：任一时刻线程要么明确指向旧 head，
   * 要么明确指向新 head；推进与指令状态 / 清挡板在同一次落盘中变更。
   *
   * 交接挡板（pendingSuccession）与 head 推进原子成对清除（换代 + 清挡板）。
   *
   * T001 身份连续性不变量：successor 加入前必须通过三道校验，任何一道失败
   * 都抛稳定错误且线程记录零变更（旧 head 保持有效）：
   *   - thread_identity_missing：线程身份归属未知（旧数据缺字段），拒绝静默
   *     放行；须宿主显式补全后重试；
   *   - session_workspace_mismatch：successor 不属于线程同一工作空间宿主；
   *   - thread_identity_mismatch：successor 身份与线程身份不一致；
   *   - session_already_in_thread：successor 已是某条线程成员（本线程的重复
   *     成员由既有 duplicate_session 覆盖）。
   */
  async advanceHead(opts: {
    threadId: string;
    toSessionId: string;
    fromSessionId?: string;
    expectedRevision?: number;
    endKind?: string;
  }): Promise<WorkThreadRecord> {
    const threadId = validateId(opts.threadId, 'threadId');
    const normalizedTo = validateId(opts.toSessionId, 'toSessionId');
    const normalizedFrom = opts.fromSessionId ? validateId(opts.fromSessionId, 'fromSessionId') : null;

    // T001 身份连续性不变量：successor 加入前的三道校验在下方 store 事务内
    // 执行（per-thread 串行锁保护，结构守卫在前）；任一失败抛稳定错误且
    // 线程记录零变更（旧 head 保持有效）：
    //   - session_workspace_mismatch：successor 不属于线程的工作空间宿主；
    //   - thread_identity_mismatch：successor 身份与线程身份不一致；
    //   - thread_identity_missing：线程身份未知且无法从 root Session 再推导
    //     （旧数据缺字段的明确失败，绝不静默放行或默认成具体身份）；
    //   - session_already_in_thread：successor 已是其它线程的成员。
    // 未注入 identitySource 时（框架独立使用）保持既有行为：不校验身份。
    const { record } = await this.store.update(
      threadId,
      async (draft) => {
        if (draft.status === WORKTHREAD_TERMINAL_STATUS) {
          throw Object.assign(new Error(`WorkThread "${threadId}" is closed`), {
            code: 'thread_closed',
            status: 409,
          });
        }
        if (normalizedFrom && draft.headSessionId !== normalizedFrom) {
          throw Object.assign(
            new Error(
              `Head mismatch on workthread "${threadId}": expected ${normalizedFrom}, current ${draft.headSessionId}`,
            ),
            { code: 'head_mismatch', status: 409 },
          );
        }
        if (draft.headSessionId === normalizedTo) {
          throw Object.assign(
            new Error(`Session "${normalizedTo}" is already the head of workthread "${threadId}"`),
            { code: 'already_head', status: 409 },
          );
        }
        if ((draft.sessionChain || []).some((entry) => entry.sessionId === normalizedTo)) {
          throw Object.assign(
            new Error(`Session "${normalizedTo}" already appears in the chain of workthread "${threadId}"`),
            { code: 'duplicate_session', status: 409 },
          );
        }

        // T001 身份连续性不变量（事务内校验，结构守卫在前）：
        //   - session_workspace_mismatch：successor 不属于线程的工作空间宿主
        //     （identitySource 以线程自身 agentId 定位不到该会话 = 非本宿主）；
        //   - thread_identity_missing：线程身份未知且无法从 root Session 再推导
        //     （旧数据缺字段的明确失败，绝不静默放行或默认成具体身份）；
        //   - thread_identity_mismatch：successor 身份与线程身份不一致；
        //   - session_already_in_thread：successor 已是其它线程的成员。
        if (this._identitySource) {
          const threadAgentId = cleanText(draft.agentId);
          const toIdentity = cleanText(await this._identitySource(threadAgentId, normalizedTo));
          if (!toIdentity) {
            throw threadIdentityError(
              `Session "${normalizedTo}" does not belong to workspace host "${threadAgentId}" of thread "${threadId}"`,
              'session_workspace_mismatch',
              409,
            );
          }
          // 线程身份归属：优先盘上事实；旧记录缺字段（null）时从 root Session
          // 的真实身份再推导并回填（事实推导，非默认值）；仍不可得则明确失败。
          let effectiveThreadIdentity = draft.identity;
          if (!effectiveThreadIdentity) {
            effectiveThreadIdentity =
              cleanText(await this._identitySource(threadAgentId, draft.rootSessionId)) || null;
            if (!effectiveThreadIdentity) {
              throw threadIdentityError(
                `Thread "${threadId}" has no identity attribution and its root session identity is unknown; backfill the root identity before advancing the head`,
                'thread_identity_missing',
                409,
              );
            }
            // 回填与 head 推进同盘原子落盘（下方 draft.identity 赋值）。
            draft.identity = effectiveThreadIdentity;
          }
          if (toIdentity !== effectiveThreadIdentity) {
            throw threadIdentityError(
              `Session "${normalizedTo}" has identity "${toIdentity}" but thread "${threadId}" is bound to identity "${effectiveThreadIdentity}"`,
              'thread_identity_mismatch',
              409,
            );
          }
          // 成员独占：successor 不得已是其它线程的成员（本线程内的重复由
          // 上方 duplicate_session 覆盖）。
          const summaries = await this.store.list();
          for (const summary of summaries as Array<{ threadId?: string }>) {
            if (!summary?.threadId || summary.threadId === threadId) continue;
            const other = await this.store.get(summary.threadId);
            if (Array.isArray(other?.sessionChain)
              && other.sessionChain.some((entry) => entry?.sessionId === normalizedTo)) {
              throw threadIdentityError(
                `Session "${normalizedTo}" is already a member of thread "${summary.threadId}"`,
                'session_already_in_thread',
                409,
              );
            }
          }
        }

        const now = Date.now();
        const currentHead = (draft.sessionChain || []).find(
          (entry) => entry.sessionId === draft.headSessionId,
        );
        if (currentHead) {
          currentHead.role = 'predecessor';
          currentHead.endedAt = now;
          currentHead.endKind = cleanText(opts.endKind) || 'manual';
          currentHead.successorSessionId = normalizedTo;
        }
        draft.sessionChain = draft.sessionChain || [];
        draft.sessionChain.push({
          sessionId: normalizedTo,
          role: 'head',
          startedAt: now,
          endedAt: null,
          endKind: null,
          successorSessionId: null,
        });
        draft.headSessionId = normalizedTo;
        // 交接完成：同一次落盘内清除交接意图（与 head 推进原子成对）。
        draft.pendingSuccession = null;
        // 接续编排状态复位为 open（执行调度运行时状态归看板，不在此层驱动）。
        draft.status = 'open';
        pushLifecycleEvent(draft, {
          type: 'handoff_completed',
          status: 'open',
          at: now,
          fromSessionId: normalizedFrom || currentHead?.sessionId || null,
          toSessionId: normalizedTo,
          reason: cleanText(opts.endKind) || 'manual',
        });
        return draft;
      },
      { expectedRevision: Number.isInteger(opts.expectedRevision) ? opts.expectedRevision : undefined },
    );

    return record;
  }

  // ── 状态迁移（锚点收口）────────────────────────────────────────

  /**
   * 关闭只表示锚点收口 + 执行载体终态（terminal 判定），不表示编排层任务完成。
   * pending 指令随关闭一并取消。
   */
  async closeThread(threadId: string, opts: { reason?: string } = {}): Promise<WorkThreadRecord> {
    const tid = validateId(threadId, 'threadId');
    const { record } = await this.store.update(tid, (draft) => {
      if (this.isTerminal(draft)) return draft;
      draft.status = WORKTHREAD_TERMINAL_STATUS;
      draft.closedAt = Date.now();
      draft.closeReason = cleanText(opts.reason) || 'closed';
      pushLifecycleEvent(draft, {
        type: 'closed',
        status: WORKTHREAD_TERMINAL_STATUS,
        at: draft.closedAt,
        reason: draft.closeReason,
      });
      const now = Date.now();
      for (const c of draft.commands || []) {
        if (c.status === WorkThreadCommandStatus.PENDING) {
          c.status = WorkThreadCommandStatus.CANCELLED;
          c.lastReason = 'thread_closed';
          c.updatedAt = now;
        }
      }
      return draft;
    });
    return record;
  }

  /** 桥注入面（供测试 stub 与宿主替换）。 */
  getBridge(): WorkThreadBridge {
    return this._bridge;
  }
}
