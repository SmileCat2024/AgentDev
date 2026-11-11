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
  pruneResolvedUnresolved,
  openUnresolvedCommands,
  classifyRetiredCommands,
  createUnresolvedRecord,
  MAX_RETAINED_RESOLVED_UNRESOLVED,
  WorkThreadCommandStatus,
  WorkThreadCommandKind,
  type WorkThreadCommand,
  type WorkThreadCommandKindValue,
  type WorkThreadUnresolvedCommand,
  type SuccessionEvidence,
} from './inbox.js';
import { WorkThreadRuntimeBridge, WORKTHREAD_BRIDGE_DISABLED_REASON } from './bridge.js';
import type { WorkThreadBridge } from './bridge.js';
import { generateWorkThreadId } from './store.js';
import { defineStateMachine, reduce } from '../state-kernel/index.js';
import type { StateMachineDef } from '../state-kernel/index.js';

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
  /**
   * R3：接续恢复指令策略。官方默认为静态文案；宿主可注入替换。
   * 策略必须是纯同步文本生成——恢复路径禁止叠加 LLM 调用等易碎件。
   */
  continuationPolicy?: WorkThreadContinuationPolicy;
}

/** 交接移交易上下文（beginSessionHandoff 播种恢复指令时传入策略）。 */
export interface WorkThreadSuccessionContext {
  threadId: string;
  fromSessionId: string;
  reason: string;
}

/** R3：接续恢复指令策略接口。compose 必须同步、纯函数。 */
export interface WorkThreadContinuationPolicy {
  composeSuccessionInstruction(ctx: WorkThreadSuccessionContext): string;
}

/**
 * R3 官方默认恢复指令（随挡板播种，睁眼第一句：先核对现实再继续）。
 * 措辞对齐 trim / summary 变换注入 successor 上下文的系统提示（Claw 侧
 * buildTrimNoticeSeedMessage 注解与框架 buildSummarySeedMessage 种子消息）
 * ——接续唤醒与上下文内注解共用同一套「审视任务状态再继续」的指引，
 * 不另起一套恢复措辞。
 */
export const DEFAULT_SUCCESSION_INSTRUCTION = [
  '上下文已精简接续。继续工作前，请先审视当前任务状态：重新阅读仍然涉及的关键文件以确认其最新内容，',
  '回顾上文中的关键结论、约定与未完成事项，核对进度后再决定下一步动作。',
].join('');

function threadIdentityError(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

/**
 * 判断指令是否派生自指定 unresolved 记录的重投：reissue 命令创建时在
 * metadata.reissueOf 写入原指令 commandId（见 resolveUnresolved）。键空间
 * 保留让正常路径的 `reissue-<unresolvedId>` 键只可能属于该记录自身的重投；
 * 不匹配即损坏态（手工编辑 / 异常迁移），调用方不得收口或返回假句柄。
 */
function isReissueDerivedFrom(
  command: { metadata?: unknown },
  target: { commandId?: unknown },
): boolean {
  const expected = typeof target?.commandId === 'string' ? target.commandId : null;
  if (!expected) return false;
  const meta = command?.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const reissueOf = (meta as { reissueOf?: unknown }).reissueOf;
  return reissueOf === expected;
}

// ── 锚点状态机转换表（state-kernel，PR-F3 / ADR-0021 阶段 1）──────────
//
// 精确等价对照（实施计划 §3 转换表 ↔ §1.1 现状基准）：
// - handoff_started（begin）：hold / rotating+fresh / head≠from 三守卫 → rotating；
//   effect 置挡板 + R3 播种（策略抛错 = 整体失败：reduce 向上抛，store.update
//   丢弃 draft，不留半套挡板）。closed 由终态保护统一拒绝。
//   反直觉现状（F2 用例锁定，严禁顺手修正）：rotation_failed + fresh 挡板上
//   begin 放行覆写——fresh 守卫只拦 status === 'rotating'（R8 单飞在该态失效）。
// - handoff_failed（fail）：from '*'（守卫不查 status：构造态 open+挡板同样
//   落卷，F2 用例 2 锁定）+ 挡板存在守卫 → rotation_failed；挡板保留，stage 补写。
// - handoff_completed（advance）：hold / head CAS / already_head / duplicate_session
//   → open；effect chain 收口 + 追加 + 清挡板。异步身份三道校验不进表（内核
//   严格同步），留在外壳事务内 reduce 之后执行——抛错时 store.update 整体丢弃
//   draft，磁盘终态与「守卫前置」等价。
// - handoff_stale（clearStaleHandoff）：挡板存在守卫；to 条件目标——仅 rotating
//   回 open，rotation_failed 清挡板后 status 保持（F2 用例 4 锁定）。
// - closed（closeThread）：无守卫 → closed；不清挡板（现状：closed 记录挡板
//   残留）；pending 指令批量 CANCELLED。
// - setHold 不上表：hold 是伴随字段门禁，不是 status 轴转换。
// event.type 直接用落盘 lifecycle 词汇；lifecycleEvent 由内核生成（type/status/
// payload 与现状同构；at 由内核在 effect 后独立采样，与旧实现「事务体单次
// Date.now() 复用到挡板 startedAt / closedAt」可能差 1ms——差分测试 fake
// timers 步内恒定不可见，无消费方依赖该相等性），外壳经 pushLifecycleEvent
// 追加落盘。

/** 锚点转换表事件词汇：type 即落盘 lifecycle type；字段由外壳归一后传入。 */
type AnchorEvent = {
  type: 'handoff_started' | 'handoff_failed' | 'handoff_completed' | 'handoff_stale' | 'closed';
  fromSessionId?: string;
  toSessionId?: string;
  reason?: string;
  stage?: string;
  error?: string | null;
  endKind?: string;
  /**
   * R3 per-call 免播开关：缺省 / true 播种恢复指令；显式 false 只立挡板
   * 不播种。手动接续（用户发起的上下文变换）免播——新 head 停住等真实
   * 输入；自动接续（context guard 等无人值守接力）不传，维持播种。
   */
  seedContinuation?: boolean;
};

/** 构建锚点转换表（闭包捕获 R3 接续策略；每个 WorkThread 实例定义期校验一次）。 */
function createWorkThreadAnchorMachine(
  continuationPolicy: WorkThreadContinuationPolicy,
): StateMachineDef<WorkThreadRecord, AnchorEvent> {
  return {
    id: 'workthread-anchor',
    statusField: 'status',
    states: {
      open: {},
      rotating: {},
      rotation_failed: {},
      closed: { terminal: true },
    },
    transitions: [
      {
        event: 'handoff_started',
        from: '*',
        guards: [
          // K9：归档/行政冻结期不开新交接
          (record) => (record.hold === true ? { code: 'thread_held' } : true),
          // R8 single-flight：仅拦 rotating + fresh；stale 残卷可覆写重开
          (record, _event, ctx) => {
            const pending = record.pendingSuccession;
            return record.status === 'rotating' && pending?.startedAt
              && ctx.now() - pending.startedAt < HANDOFF_STALE_MS
              ? { code: 'handoff_in_progress' }
              : true;
          },
          (record, event) => (
            record.headSessionId !== event.fromSessionId ? { code: 'head_mismatch' } : true
          ),
        ],
        to: 'rotating',
        eventPayload: (_record, event) => ({ fromSessionId: event.fromSessionId!, reason: event.reason! }),
        effect: (record, event, ctx) => {
          const now = ctx.now();
          record.pendingSuccession = {
            fromSessionId: event.fromSessionId!,
            reason: event.reason!,
            stage: 'started',
            startedAt: now,
          };
          // R3：恢复指令随挡板同笔原子写入。策略抛错 = 整个 begin 失败，
          // 不留半套挡板（显式失败优于静默缺指令）。
          // seedContinuation=false：调用方显式免播（宿主手动接续——变换完成、
          // head 推进后停在产物上等下一条真实输入；自动接续不传，维持
          // 播种）。免播时策略彻底不参与：不调用，也不因策略故障失败 begin。
          if (event.seedContinuation !== false) {
            const instructionText = continuationPolicy.composeSuccessionInstruction({
              threadId: record.threadId,
              fromSessionId: event.fromSessionId!,
              reason: event.reason!,
            });
            if (typeof instructionText === 'string' && instructionText.trim()) {
              const instruction = createCommandRecord({
                threadId: record.threadId,
                kind: WorkThreadCommandKind.SYSTEM_CONTINUATION,
                text: instructionText,
                source: 'thread-succession',
                idempotencyKey: `succession:${record.threadId}:${event.fromSessionId}`,
              });
              instruction.createdAt = now;
              appendCommandToRecord(record, instruction);
              pruneCommands(record);
            }
          }
        },
      },
      {
        // from 必须是 '*'：现状守卫不查 status（构造态 open+挡板也立卷）
        event: 'handoff_failed',
        from: '*',
        guards: [
          // 迟到失败者没有立卷资格（无挡板 → 拒绝，外壳处置为 no-op）
          (record) => (record.pendingSuccession ? true : false),
        ],
        to: 'rotation_failed',
        eventPayload: (_record, event) => ({
          reason: event.reason!,
          stage: event.stage || 'unknown',
          error: event.error ?? null,
        }),
        effect: (record, event) => {
          const pending = record.pendingSuccession;
          if (pending) {
            // 挡板保留；stage 补写（缺省沿用盘上值，再缺省 'unknown'）
            pending.stage = event.stage || pending.stage || 'unknown';
          }
        },
      },
      {
        event: 'handoff_completed',
        from: '*',
        guards: [
          (record) => (record.hold === true ? { code: 'thread_held' } : true),
          (record, event) => (
            record.headSessionId !== event.fromSessionId ? { code: 'head_mismatch' } : true
          ),
          (record, event) => (
            record.headSessionId === event.toSessionId ? { code: 'already_head' } : true
          ),
          (record, event) => (
            (record.sessionChain || []).some((entry) => entry.sessionId === event.toSessionId)
              ? { code: 'duplicate_session' }
              : true
          ),
        ],
        to: 'open',
        eventPayload: (_record, event) => ({
          fromSessionId: event.fromSessionId!,
          toSessionId: event.toSessionId!,
          reason: event.endKind!,
        }),
        effect: (record, event, ctx) => {
          const now = ctx.now();
          const currentHead = (record.sessionChain || []).find(
            (entry) => entry.sessionId === record.headSessionId,
          );
          if (currentHead) {
            currentHead.role = 'predecessor';
            currentHead.endedAt = now;
            currentHead.endKind = event.endKind || 'manual';
            currentHead.successorSessionId = event.toSessionId!;
          }
          record.sessionChain = record.sessionChain || [];
          record.sessionChain.push({
            sessionId: event.toSessionId!,
            role: 'head',
            startedAt: now,
            endedAt: null,
            endKind: null,
            successorSessionId: null,
          });
          record.headSessionId = event.toSessionId!;
          record.headGeneration = Math.max(1, Number(record.headGeneration) || 1) + 1;
          // 交接完成：同一次落盘内清除交接意图（与 head 推进原子成对）。
          record.pendingSuccession = null;
        },
      },
      {
        event: 'handoff_stale',
        from: '*',
        guards: [
          // 无挡板 → 拒绝（外壳处置为 no-op）
          (record) => (record.pendingSuccession ? true : false),
        ],
        // 条件目标：仅 rotating 回 open；rotation_failed 等清挡板后 status 保持
        to: (record) => (record.status === 'rotating' ? 'open' : null),
        eventPayload: () => ({}),
        effect: (record) => {
          record.pendingSuccession = null;
        },
      },
      {
        event: 'closed',
        from: '*',
        to: WORKTHREAD_TERMINAL_STATUS,
        eventPayload: (_record, event) => ({ reason: event.reason! }),
        effect: (record, event, ctx) => {
          const closedAt = ctx.now();
          record.closedAt = closedAt;
          record.closeReason = event.reason!;
          const now = ctx.now();
          // 现状：收口不清挡板；pending 指令随关闭一并取消
          for (const c of record.commands || []) {
            if (c.status === WorkThreadCommandStatus.PENDING) {
              c.status = WorkThreadCommandStatus.CANCELLED;
              c.lastReason = 'thread_closed';
              c.updatedAt = now;
            }
          }
        },
      },
    ],
  };
}


export class WorkThread {
  readonly store: WorkThreadStore;
  private readonly _bridge: WorkThreadBridge;
  private readonly _identitySource?: (agentId: string, sessionId: string) => Promise<string | null> | string | null;
  private readonly _continuationPolicy: WorkThreadContinuationPolicy;
  private readonly _anchorMachine: StateMachineDef<WorkThreadRecord, AnchorEvent>;

  constructor({ store, bridge, identitySource, continuationPolicy }: WorkThreadOptions) {
    this.store = store;
    this._bridge = bridge || new WorkThreadRuntimeBridge();
    this._identitySource =
      identitySource && typeof identitySource === 'function' ? identitySource : undefined;
    this._continuationPolicy =
      continuationPolicy && typeof continuationPolicy.composeSuccessionInstruction === 'function'
        ? continuationPolicy
        : { composeSuccessionInstruction: () => DEFAULT_SUCCESSION_INSTRUCTION };
    this._anchorMachine = defineStateMachine(createWorkThreadAnchorMachine(this._continuationPolicy));
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

  /** Return the stable head generation, deriving it for legacy records. */
  headGeneration(record: WorkThreadRecord): number {
    if (Number.isInteger(record.headGeneration) && Number(record.headGeneration) > 0) {
      return Number(record.headGeneration);
    }
    return Math.max(1, Array.isArray(record.sessionChain) ? record.sessionChain.length : 1);
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
   *
   * 成员判定的权威路径是索引：updateIndexEntry 每次写盘都从记录链派生
   * sessionIds，所以携带 sessionIds 的索引条目对「非成员」是否定权威，
   * 不再回读记录文件验证（宿主「新会话建线程前检查」每次必 miss，若
   * miss 即全量回读，成本随线程数线性放大）。仅缺 sessionIds 的老条目
   * 保留记录回读兜底。已知收窄：记录已写、索引未更的崩溃窗口内，新
   * 成员会被判为非成员；该线程任一后续写操作即自愈。
   */
  async findThreadBySession(agentId: string, sessionId: string): Promise<WorkThreadRecord | null> {
    const normalizedAgentId = cleanText(agentId);
    const normalizedSessionId = cleanText(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) return null;
    const threads = await this.listThreads({ agentId: normalizedAgentId }) as Array<{
      threadId?: string;
      sessionIds?: string[];
    }>;
    const indexedMatch = threads.find((summary) =>
      summary?.threadId
      && Array.isArray(summary.sessionIds)
      && summary.sessionIds.includes(normalizedSessionId),
    );
    if (indexedMatch?.threadId) {
      const record = await this.store.get(indexedMatch.threadId);
      if (Array.isArray(record?.sessionChain)
        && record.sessionChain.some((entry) => entry?.sessionId === normalizedSessionId)) {
        return record;
      }
    }

    // Older indexes may not contain sessionIds, and a stale index must not make
    // a real member undiscoverable. Scan only those legacy entries: entries that
    // do carry sessionIds are authoritative negatives for membership (written
    // from the record chain), so re-reading their files is pure cost.
    for (const summary of threads) {
      if (!summary?.threadId || summary.threadId === indexedMatch?.threadId) continue;
      if (Array.isArray(summary.sessionIds)) continue;
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
      headGeneration: 1,
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
   * 标记线程进入交接：原子写入 pendingSuccession + status=rotating，并在同
   * 一笔事务内播种接续恢复指令（R3：createdAt 与挡板同拍，早于一切交接期
   * 积压；幂等键绑移交易 (threadId, fromSessionId)，失败恢复重走不会重复）。
   *
   * seedContinuation 显式 false 时免播：只立挡板不播种恢复指令——手动接续
   * （用户发起的上下文变换）变换完成后新 head 停住，不自动启动新一轮；
   * 自动接续（无人值守接力）缺省播种，新 head 以恢复指令「睁眼第一句」
   * 续跑。免播时 continuationPolicy 不参与（不调用、不因策略故障失败）。
   *
   * 门禁（按序）：
   *   - closed → thread_closed（硬终态）
   *   - hold → thread_held（归档/行政冻结期不开新交接，K9）
   *   - 已有 fresh 交接在办 → handoff_in_progress（并发竞争显式拒绝而非
   *     幂等刷新续命，R8 跨入口 single-flight 锚点；stale 残卷可覆写重开）
   *   - fromSessionId ≠ 当前 head → head_mismatch
   */
  async beginSessionHandoff(opts: {
    threadId: string;
    fromSessionId: string;
    reason?: string;
    seedContinuation?: boolean;
  }): Promise<WorkThreadRecord> {
    const threadId = validateId(opts.threadId, 'threadId');
    const normalizedFrom = validateId(opts.fromSessionId, 'fromSessionId');
    const normalizedReason = cleanText(opts.reason) || 'manual';
    const { record } = await this.store.update(threadId, (draft) => {
      const result = reduce(
        this._anchorMachine,
        draft,
        {
          type: 'handoff_started',
          fromSessionId: normalizedFrom,
          reason: normalizedReason,
          seedContinuation: opts.seedContinuation,
        },
        { now: () => Date.now() },
      );
      if (result.type === 'transitioned') {
        pushLifecycleEvent(draft, result.lifecycleEvent);
        return draft;
      }
      if (result.type === 'unhandled') {
        throw new Error(
          `WorkThread "${threadId}" status "${draft.status}" is not a declared anchor state`,
        );
      }
      // rejected：guard code（或终态保护）→ 现有错误形态（code/status/message 逐一对应）
      if (result.reason === 'terminal') {
        throw Object.assign(new Error(`WorkThread "${threadId}" is closed`), {
          code: 'thread_closed',
          status: 409,
        });
      }
      if (result.reason === 'thread_held') {
        throw Object.assign(new Error(`WorkThread "${threadId}" is held (administrative freeze)`), {
          code: 'thread_held',
          status: 409,
        });
      }
      if (result.reason === 'handoff_in_progress') {
        throw Object.assign(
          new Error(`WorkThread "${threadId}" already has a handoff in progress; concurrent succession requests are rejected`),
          { code: 'handoff_in_progress', status: 409 },
        );
      }
      // 唯一剩余守卫 code：head_mismatch
      throw Object.assign(
        new Error(`Handoff source is not the current head of workthread "${threadId}"`),
        { code: 'head_mismatch', status: 409 },
      );
    });
    return record;
  }

  /**
   * 惰性清除陈旧的交接意图（投递路径发现 stale 时恢复常态）。
   */
  private async clearStaleHandoff(threadId: string): Promise<void> {
    await this.store.update(threadId, (draft) => {
      const result = reduce(this._anchorMachine, draft, { type: 'handoff_stale' }, { now: () => Date.now() });
      // rejected（终态 / 无挡板）= 现状 no-op：投递路径进入前已有 closed 门禁
      if (result.type === 'transitioned') {
        pushLifecycleEvent(draft, result.lifecycleEvent);
      }
      return draft;
    });
  }

  /**
   * 标记交接失败为接续编排状态 rotation_failed，不折叠成通用执行失败。
   * pendingSuccession 保留在盘上，供后续 resume 检查被打断的确切 stage。
   *
   * K3 守卫（事务内）：失败记录的资格来自「在办移交」本身——
   *   - closed 线程：硬终态，任何迟到失败不得覆写（返回原记录，零写入）；
   *   - 无 pendingSuccession（移交已成功推进 / 从未开始）：迟到的失败者
   *     没有立卷资格，no-op 返回。这两条共同保证：只有「挡板仍在」的在办
   *     移交失败才会落 rotation_failed。
   */
  async failSessionHandoff(
    threadId: string,
    opts: { reason?: string; stage?: string; error?: unknown } = {},
  ): Promise<WorkThreadRecord> {
    const tid = validateId(threadId, 'threadId');
    const { record } = await this.store.update(tid, (draft) => {
      const result = reduce(
        this._anchorMachine,
        draft,
        {
          type: 'handoff_failed',
          reason: cleanText(opts.reason) || 'handoff_failed',
          stage: cleanText(opts.stage),
          error: opts.error != null ? String(opts.error) : null,
        },
        { now: () => Date.now() },
      );
      // rejected（closed 终态 / 无挡板守卫）= 现状 no-op：迟到失败者没有立卷资格
      if (result.type === 'transitioned') {
        pushLifecycleEvent(draft, result.lifecycleEvent);
      }
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
    images?: string[];
    metadata?: Record<string, unknown>;
    /** 来源侧引用（ADR-0031 步骤一）：由 sourceRef 携带进入线程域的输入随行记录，框架只透传不解释 */
    originSourceRef?: string;
  }): Promise<{ command: WorkThreadCommand; duplicate: boolean; threadRevision: number }> {
    const threadId = validateId(opts.threadId, 'threadId');
    // kind 为官方封闭词表：未传按 user_message；显式传入未知值直接拒绝——
    // 静默降级会让自定义词汇的调用方误以为意图已按原样入箱。
    const normalizedKind = opts.kind === undefined || opts.kind === ''
      ? WorkThreadCommandKind.USER_MESSAGE
      : opts.kind;
    if (!Object.values(WorkThreadCommandKind).includes(normalizedKind as never)) {
      throw Object.assign(
        new Error(
          `Unknown command kind "${normalizedKind}" (expected one of: ${Object.values(WorkThreadCommandKind).join(', ')})`,
        ),
        { code: 'invalid_request', status: 400 },
      );
    }
    const normalizedText = String(opts.text || '');
    const normalizedImages = Array.isArray(opts.images)
      ? opts.images.filter((entry) => typeof entry === 'string' && entry.trim())
      : [];
    const hasMetadata = !!(opts.metadata && typeof opts.metadata === 'object'
      && !Array.isArray(opts.metadata) && Object.keys(opts.metadata).length > 0);
    // K8：images / text / metadata 至少其一非空——图片优先的输入不应被强制携带
    // 占位文本，metadata-only（如仅携带会话引用）同样是内容承载
    if (!normalizedText.trim() && normalizedImages.length === 0 && !hasMetadata) {
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
    // metadata 形状防线与 viewer user-turn 同源（plain object、可序列化、
    // ≤16KB）：入箱必可投——缺这道防线时超大/不可序列化 metadata 会在
    // 投递跳（viewer 校验 / store 序列化）才失败，指令落 FAILED 终态
    if (opts.metadata !== undefined) {
      let serialized: string | null = null;
      try {
        serialized = JSON.stringify(opts.metadata);
      } catch {
        // 循环引用等不可序列化形态保持 null，按非法 metadata 拒绝
      }
      if (typeof opts.metadata !== 'object' || opts.metadata === null || Array.isArray(opts.metadata)
        || serialized === null || serialized.length > 16_384) {
        throw Object.assign(
          new Error('Command metadata must be a serializable plain object of at most 16KB'),
          { code: 'invalid_request', status: 400 },
        );
      }
    }

    const command = createCommandRecord({
      threadId,
      kind: normalizedKind,
      text: normalizedText,
      source: cleanText(opts.source) || 'ui',
      idempotencyKey: cleanText(opts.idempotencyKey),
      ...(Array.isArray(opts.capabilityActivations) ? { capabilityActivations: opts.capabilityActivations } : {}),
      ...(normalizedImages.length > 0 ? { images: normalizedImages } : {}),
      ...(opts.metadata && typeof opts.metadata === 'object' && !Array.isArray(opts.metadata)
        && Object.keys(opts.metadata).length > 0 ? { metadata: opts.metadata } : {}),
      ...(typeof opts.originSourceRef === 'string' && opts.originSourceRef.trim()
        ? { originSourceRef: opts.originSourceRef.trim() }
        : {}),
    });

    let appendOutcome = { command, duplicate: false };
    const { record } = await this.store.update(threadId, (draft) => {
      if (draft.status === WORKTHREAD_TERMINAL_STATUS) {
        throw Object.assign(new Error(`WorkThread "${threadId}" is closed; terminal threads hold no new commands`), {
          code: 'thread_closed',
          status: 409,
        });
      }
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

    // K20：逐条投递前重读线程记录。HTTP 投递是慢操作，循环期间 head 可能
    // 换代、挡板可能竖起、指令可能被取消——按入口快照盲投会把指令送进已
    // 退役的会话（delivered 但结果留在旧棒）。每条指令以「当下事实」投递；
    // 客观门禁任一失守即停（剩余指令保持 pending，交给下一个触发点）。
    for (const command of pending) {
      const fresh = await this.store.get(tid);
      if (!fresh) throw new WorkThreadNotFoundError(tid);
      if (this.isTerminal(fresh)) {
        stopReason = 'thread_closed';
        break;
      }
      if (fresh.hold === true) {
        stopReason = 'thread_held';
        break;
      }
      if (fresh.pendingSuccession && this.isHandoffActive(fresh)) {
        stopReason = 'handoff_in_progress';
        break;
      }
      if (fresh.headSessionId !== thread.headSessionId) {
        stopReason = 'head_changed';
        break;
      }
      const freshCommand = (fresh.commands || []).find((c) => c?.commandId === command.commandId) || null;
      if (!freshCommand || freshCommand.status !== WorkThreadCommandStatus.PENDING) {
        // 循环期间被取消/已终态：跳过（不投递、不标记、不进结果集）
        continue;
      }

      // R3 唤醒指令的措辞前提是「上下文已精简接续」——只有 head 已推进（≠
      // 播种时的 from 会话）才成立。接续失败后挡板收敛、head 未动：向从未
      // 精简的旧 head 宣读精简前提是假前提指令（wt-58471cd9 事故链），作废。
      // 幂等键只认 PENDING/DELIVERED，重试接续（同 from 再 begin）会重新播种。
      const successionKeyPrefix = `succession:${tid}:`;
      if (freshCommand.kind === WorkThreadCommandKind.SYSTEM_CONTINUATION
        && typeof freshCommand.idempotencyKey === 'string'
        && freshCommand.idempotencyKey.startsWith(successionKeyPrefix)
        && fresh.headSessionId === freshCommand.idempotencyKey.slice(successionKeyPrefix.length)) {
        results.push({
          commandId: command.commandId,
          accepted: false,
          retryable: false,
          reason: 'succession_precondition_violated',
        });
        continue;
      }

      const outcome = await this._bridge.deliver({
        thread: { ...fresh, headGeneration: this.headGeneration(fresh) },
        command: freshCommand,
      });
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
          // 循环期间被并发 cancel 的指令不覆写终态：取消意图保留
          if (c.status !== WorkThreadCommandStatus.PENDING) continue;
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
   * fromSessionId 必填（K23）：它是调用方声明的 CAS 期望值——不传即
   * 「接受任意当前 head」，幽灵任务防串台将被合法绕过。调用方若不知道
   * 当前 head，应先读线程再用读到的值调用（CLI 的自动填充即此语义）。
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
    fromSessionId: string;
    expectedRevision?: number;
    endKind?: string;
  }): Promise<WorkThreadRecord> {
    const threadId = validateId(opts.threadId, 'threadId');
    const normalizedTo = validateId(opts.toSessionId, 'toSessionId');
    const normalizedFrom = validateId(opts.fromSessionId, 'fromSessionId');
    const normalizedEndKind = cleanText(opts.endKind) || 'manual';

    // T001 身份连续性不变量：successor 加入前的三道校验在下方 store 事务内、
    // reduce 之后执行（内核严格同步，异步守卫不进转换表；结构守卫在表内已先行
    // 求值，身份校验失败时 store.update 整体丢弃 draft，磁盘终态与「守卫前置」
    // 等价）：
    //   - thread_held：行政冻结期（归档）head 不得推进——归档宣告终局后，
    //     在途接力的迟到推进同样被拒（与 begin 的 K9 门禁同源）；
    //   - session_workspace_mismatch：successor 不属于线程的工作空间宿主；
    //   - thread_identity_mismatch：successor 身份与线程身份不一致；
    //   - thread_identity_missing：线程身份未知且无法从 root Session 再推导
    //     （旧数据缺字段的明确失败，绝不静默放行或默认成具体身份）；
    //   - session_already_in_thread：successor 已是其它线程的成员。
    // 未注入 identitySource 时（框架独立使用）保持既有行为：不校验身份。
    const { record } = await this.store.update(
      threadId,
      async (draft) => {
        const result = reduce(
          this._anchorMachine,
          draft,
          {
            type: 'handoff_completed',
            fromSessionId: normalizedFrom,
            toSessionId: normalizedTo,
            endKind: normalizedEndKind,
          },
          { now: () => Date.now() },
        );
        if (result.type !== 'transitioned') {
          if (result.type === 'unhandled') {
            throw new Error(
              `WorkThread "${threadId}" status "${draft.status}" is not a declared anchor state`,
            );
          }
          // rejected：guard code（或终态保护）→ 现有错误形态（code/status/message 逐一对应）
          if (result.reason === 'terminal') {
            throw Object.assign(new Error(`WorkThread "${threadId}" is closed`), {
              code: 'thread_closed',
              status: 409,
            });
          }
          if (result.reason === 'thread_held') {
            throw Object.assign(
              new Error(`WorkThread "${threadId}" is held (administrative freeze); head cannot advance`),
              { code: 'thread_held', status: 409 },
            );
          }
          if (result.reason === 'head_mismatch') {
            throw Object.assign(
              new Error(
                `Head mismatch on workthread "${threadId}": expected ${normalizedFrom}, current ${draft.headSessionId}`,
              ),
              { code: 'head_mismatch', status: 409 },
            );
          }
          if (result.reason === 'already_head') {
            throw Object.assign(
              new Error(`Session "${normalizedTo}" is already the head of workthread "${threadId}"`),
              { code: 'already_head', status: 409 },
            );
          }
          // 唯一剩余守卫 code：duplicate_session
          throw Object.assign(
            new Error(`Session "${normalizedTo}" already appears in the chain of workthread "${threadId}"`),
            { code: 'duplicate_session', status: 409 },
          );
        }
        pushLifecycleEvent(draft, result.lifecycleEvent);

        // T001 身份连续性不变量（事务内校验，结构守卫在前）：
        //   - session_workspace_mismatch：successor 不属于线程的工作空间宿主
        //   - thread_identity_missing：线程身份未知且无法从 root Session 再推导
        //   - thread_identity_mismatch：successor 身份与线程身份不一致
        //   - session_already_in_thread：successor 已是其它线程的成员。
        await this.assertSuccessorIdentity(draft, normalizedTo);

        return draft;
      },
      { expectedRevision: Number.isInteger(opts.expectedRevision) ? opts.expectedRevision : undefined },
    );

    return record;
  }

  /**
   * T001 身份连续性不变量的事务内校验（advanceHead 与 commitSessionSuccession
   * 共用的单一实现）。校验通过时可能有 draft.identity 回填副作用（留在 draft
   * 上，随外层事务原子落盘）；校验失败抛 409 错误，外层 store.update 整体
   * 丢弃 draft。
   */
  private async assertSuccessorIdentity(
    draft: WorkThreadRecord,
    normalizedTo: string,
  ): Promise<void> {
    if (!this._identitySource) return;
    const threadId = draft.threadId;
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
      // 回填与 head 推进同盘原子落盘（draft.identity 赋值）。
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
    // duplicate_session 覆盖）。
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

  // ── 原子接续提交与 unresolved 处置（ADR-0047 阶段 2）──────────────

  /**
   * 原子接续提交：head 推进、挡板清除、退役棒指令消费分类、unresolved
   * 持久化在同一次 store.update 内完成（单文件原子写 + per-thread 串行锁
   * + expectedRevision CAS）。任一环节失败整体丢弃 draft，磁盘无半套状态。
   * 原子性边界：指 thread record 文件本身；写记录之后、updateIndexEntry
   * 之前崩溃会让 index.json 摘要短暂陈旧——index 是可重建投影（list 消费方
   * 经 getThread 读权威记录），下一次任何写都会刷新该条目，不构成恢复
   * 依据的丢失窗口（阶段 2a 审查核实）。
   *
   * 分类语义与宿主判定闸同源（ADR-0047 决策 2）：退役棒 delivered 指令
   * 只有可靠消费引用（turn.* 事件携带的 sourceRef / consumedSourceRefs）
   * 才算已消费；无法判定的指令不失败、不重放、不静默滞留——转为
   * unresolved 一等事实随本事务持久，处置（consumed / reissue / discard）
   * 是后续的显式决定。
   *
   * 证据经宿主在事务外读取后以类型化快照注入（锚点层不 import 看板模块）。
   * 读取与提交之间的迟到事件只可能把「无法判定」升级为「已消费」（正向
   * 引用只增不减），错过迟到引用最多多建一条 unresolved（显式处置可收敛），
   * 不会反向误判。缺省不传 evidence 视为 integrity 'missing'（保守）；
   * integrity 'unreadable'（瞬时读取失败）在本方法入口被拒绝（可重试
   * 409 evidence_unreadable），不进入分类。
   *
   * 崩溃窗口：事务提交后、响应返回前进程死亡——调用方重试时 from 已不是
   * head，handoff_completed 的 head CAS 守卫以 head_mismatch 拒绝（幂等），
   * unresolved 与换头事实均已持久，无丢失窗口。
   *
   * 强制发现通知（ADR-0047 阶段 2b）：自动接续传 composeNotice 回调时，
   * 本事务在 unresolved 创建后立即构造通知指令入箱（幂等键
   * `succession-notice:<threadId>:<toSessionId>`）。通知与换头/unresolved
   * 同事务原子——不存在「已换头但通知未追加」的窗口（阶段 2b 审查发现：
   * 事务外追加在 commit 后崩溃会因 head CAS 拒绝重试而永不补建，未决项
   * 有记录但永不进入后继首轮）。手动免播路径不传 composeNotice（通知
   * 会唤醒轮次，违反免播语义）；未决事实经 listUnresolved API 面可见。
   *
   * @returns record 提交后线程记录；unresolved 本事务新建的未决记录；
   *          consumedCommandIds 有可靠消费引用、保持 delivered 终态的指令。
   */
  async commitSessionSuccession(opts: {
    threadId: string;
    fromSessionId: string;
    toSessionId: string;
    expectedRevision?: number;
    endKind?: string;
    evidence?: SuccessionEvidence;
    composeNotice?: (unresolved: WorkThreadUnresolvedCommand[]) => { text: string } | null;
  }): Promise<{
    record: WorkThreadRecord;
    unresolved: WorkThreadUnresolvedCommand[];
    consumedCommandIds: string[];
  }> {
    const threadId = validateId(opts.threadId, 'threadId');
    const normalizedTo = validateId(opts.toSessionId, 'toSessionId');
    const normalizedFrom = validateId(opts.fromSessionId, 'fromSessionId');
    const normalizedEndKind = cleanText(opts.endKind) || 'manual';
    // unreadable（读取抛错，重试可恢复证据）拒绝换头：不建 unresolved、不
    // 推进 head，调用方按可重试失败收敛（ADR 阶段 1「读取失败不推进」语义
    // 在阶段 2 保留——unresolved 只承接结构性缺失 missing / corrupt）。
    if (opts.evidence?.integrity === 'unreadable') {
      throw Object.assign(
        new Error(
          `Succession evidence unreadable for workthread "${threadId}" (${opts.evidence.note || 'read failed'}); retry when the board is readable`,
        ),
        { code: 'evidence_unreadable', status: 409 },
      );
    }
    const evidence: SuccessionEvidence = opts.evidence
      && (opts.evidence.integrity === 'ok' || opts.evidence.integrity === 'corrupt')
      ? opts.evidence
      : { integrity: 'missing', events: [] };

    const createdUnresolved: WorkThreadUnresolvedCommand[] = [];
    const consumedCommandIds: string[] = [];

    const { record } = await this.store.update(
      threadId,
      async (draft) => {
        // 换头守卫与效果：与 advanceHead 完全同源（hold / head CAS /
        // already_head / duplicate_session / 终态保护 + chain 收口清挡板）。
        const result = reduce(
          this._anchorMachine,
          draft,
          {
            type: 'handoff_completed',
            fromSessionId: normalizedFrom,
            toSessionId: normalizedTo,
            endKind: normalizedEndKind,
          },
          { now: () => Date.now() },
        );
        if (result.type !== 'transitioned') {
          if (result.type === 'unhandled') {
            throw new Error(
              `WorkThread "${threadId}" status "${draft.status}" is not a declared anchor state`,
            );
          }
          if (result.reason === 'terminal') {
            throw Object.assign(new Error(`WorkThread "${threadId}" is closed`), {
              code: 'thread_closed',
              status: 409,
            });
          }
          if (result.reason === 'thread_held') {
            throw Object.assign(
              new Error(`WorkThread "${threadId}" is held (administrative freeze); head cannot advance`),
              { code: 'thread_held', status: 409 },
            );
          }
          if (result.reason === 'head_mismatch') {
            throw Object.assign(
              new Error(`Head mismatch on workthread "${threadId}": expected ${normalizedFrom}, current ${draft.headSessionId}`),
              { code: 'head_mismatch', status: 409 },
            );
          }
          if (result.reason === 'already_head') {
            throw Object.assign(
              new Error(`Session "${normalizedTo}" is already the head of workthread "${threadId}"`),
              { code: 'already_head', status: 409 },
            );
          }
          throw Object.assign(
            new Error(`Session "${normalizedTo}" already appears in the chain of workthread "${threadId}"`),
            { code: 'duplicate_session', status: 409 },
          );
        }
        pushLifecycleEvent(draft, result.lifecycleEvent);

        // T001 身份连续性不变量（与 advanceHead 共用实现）。
        await this.assertSuccessorIdentity(draft, normalizedTo);

        // 退役棒指令消费分类：无法判定 → unresolved 一等事实（同事务持久）。
        const classification = classifyRetiredCommands(draft, normalizedFrom, evidence);
        consumedCommandIds.push(...classification.consumedCommandIds);
        if (classification.undecidable.length > 0) {
          const reasons = [...new Set(classification.undecidable.map((entry) => entry.reason))];
          for (const { command, reason } of classification.undecidable) {
            const unresolved = createUnresolvedRecord(command, normalizedFrom, reason);
            draft.unresolvedCommands = [
              ...(Array.isArray(draft.unresolvedCommands) ? draft.unresolvedCommands : []),
              unresolved,
            ];
            createdUnresolved.push(unresolved);
          }
          pushLifecycleEvent(draft, {
            type: 'unresolved_created',
            status: draft.status,
            at: Date.now(),
            fromSessionId: normalizedFrom,
            toSessionId: normalizedTo,
            count: classification.undecidable.length,
            reasons,
            commandIds: classification.undecidable.map((entry) => entry.command.commandId),
          });

          // 强制发现通知与换头/unresolved 同事务：commit 后崩溃也不存在
          // 「已换头、unresolved 已持久，但通知永不进入后继首轮」的窗口。
          // 回调抛错 = 整体失败回滚（换头不发生），调用方重试。
          if (typeof opts.composeNotice === 'function') {
            const notice = opts.composeNotice(createdUnresolved);
            if (notice && typeof notice.text === 'string' && notice.text.trim()) {
              const noticeCommand = createCommandRecord({
                threadId,
                kind: WorkThreadCommandKind.SYSTEM_CONTINUATION,
                text: notice.text,
                source: 'thread_succession',
                idempotencyKey: `succession-notice:${threadId}:${normalizedTo}`,
              });
              appendCommandToRecord(draft, noticeCommand);
              pruneCommands(draft);
            }
          }
        }

        return draft;
      },
      { expectedRevision: Number.isInteger(opts.expectedRevision) ? opts.expectedRevision : undefined },
    );

    return { record, unresolved: createdUnresolved, consumedCommandIds };
  }

  /**
   * 未决指令处置（ADR-0047 阶段 2）：对一条 open 的 unresolved 记录做显式收口。
   *
   * 处置方式（都是决定，不是推断）：
   *   - consumed：核实确认已被旧会话消费，仅标记收口；
   *   - discard：放弃该指令（过期 / 无效 / 已由其它途径覆盖），仅标记收口；
   *   - reissue：以原载荷重新入箱一条 pending 指令（de4d5d03 的重投路径，
   *     现在是显式处置动作）。新指令的幂等键固定为 `reissue-<unresolvedId>`
   *     ——沿用旧键会命中 appendCommand 对 delivered 的幂等去重，重投落空；
   *     不提供自定义键：处置面无需区分调用方，固定键同时消除幂等冲突面
   *     （阶段 2a 审查裁定：duplicate 命中时静默指向未入箱对象的缺陷面）。
   *     deliveryRef 不进 unresolved 快照：reissue 语义不需要投递审计标识，
   *     投递审计事实在 commands 本体（有意取舍）。
   *
   * 幂等：重复以相同方式处置已收口的记录返回现状（不重复 reissue）；
   * 以不同方式处置已收口的记录是冲突，409 拒绝。
   * closed 线程拒绝 reissue（终态不开新指令）；consumed / discard 在
   * closed 线程上允许（归档后清理未决是合法运维动作，不动 commands）。
   *
   * @returns record 处置后线程记录；command reissue 时新建的 pending 指令
   */
  async resolveUnresolved(opts: {
    threadId: string;
    unresolvedId: string;
    resolution: 'consumed' | 'reissue' | 'discard';
    note?: string;
  }): Promise<{ record: WorkThreadRecord; command: WorkThreadCommand | null }> {
    const threadId = validateId(opts.threadId, 'threadId');
    const unresolvedId = cleanText(opts.unresolvedId);
    const resolution = opts.resolution;
    if (resolution !== 'consumed' && resolution !== 'reissue' && resolution !== 'discard') {
      throw Object.assign(
        new Error(`Invalid resolution "${resolution}" (expected consumed | reissue | discard)`),
        { code: 'invalid_request', status: 400 },
      );
    }

    let reissued: WorkThreadCommand | null = null;

    const { record } = await this.store.update(threadId, (draft) => {
      const all = Array.isArray(draft.unresolvedCommands) ? draft.unresolvedCommands : [];
      const target = all.find((entry) => entry?.unresolvedId === unresolvedId);
      if (!target) {
        throw Object.assign(
          new Error(`Unresolved command "${unresolvedId}" not found on workthread "${threadId}"`),
          { code: 'unresolved_not_found', status: 404 },
        );
      }
      // 幂等：相同处置返回现状（reissue 时找回既有重投指令供对账——幂等
      // 重试的调用方不因重复请求丢失指令句柄）；不同处置是冲突。
      if (target.resolvedAt) {
        if (target.resolution === resolution) {
          if (resolution === 'reissue') {
            const existing = (draft.commands || []).find(
              (c) => c?.idempotencyKey === `reissue-${target.unresolvedId}`,
            ) ?? null;
            // 防御：找回的重投指令必须确实派生自该 unresolved（metadata.reissueOf
            // 指回其原指令）。键空间保留（appendCommand 守卫）让正常路径构造不出
            // 不匹配状态；此处拦截的是手工编辑 / 损坏记录，不得把无关命令当
            // 对账句柄返回。
            if (existing && !isReissueDerivedFrom(existing, target)) {
              throw Object.assign(
                new Error(
                  `idempotencyKey "reissue-${target.unresolvedId}" is occupied by an unrelated command ${existing.commandId}`,
                ),
                { code: 'inconsistent_state', status: 500 },
              );
            }
            reissued = existing;
          }
          return draft;
        }
        throw Object.assign(
          new Error(
            `Unresolved command "${unresolvedId}" already resolved as "${target.resolution}"; cannot re-resolve as "${resolution}"`,
          ),
          { code: 'unresolved_already_resolved', status: 409 },
        );
      }
      if (resolution === 'reissue' && draft.status === WORKTHREAD_TERMINAL_STATUS) {
        throw Object.assign(
          new Error(`WorkThread "${threadId}" is closed; terminal threads hold no new commands`),
          { code: 'thread_closed', status: 409 },
        );
      }

      const now = Date.now();
      target.resolvedAt = now;
      target.resolution = resolution;
      target.resolutionNote = cleanText(opts.note) || null;
      target.updatedAt = now;

      if (resolution === 'reissue') {
        const command = createCommandRecord({
          threadId,
          kind: target.kind as WorkThreadCommandKindValue,
          text: target.text,
          source: target.source,
          idempotencyKey: `reissue-${target.unresolvedId}`,
          ...(Array.isArray(target.capabilityActivations)
            ? { capabilityActivations: [...target.capabilityActivations] }
            : {}),
          ...(Array.isArray(target.images) ? { images: [...target.images] } : {}),
          ...(target.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata)
            // 深拷贝：避免调用方对快照 metadata 的原地修改穿透进新指令
            ? { metadata: { ...structuredClone(target.metadata), reissueOf: target.commandId } }
            : { metadata: { reissueOf: target.commandId } }),
          ...(typeof target.originSourceRef === 'string' && target.originSourceRef
            ? { originSourceRef: target.originSourceRef }
            : {}),
        });
        const appendOutcome = appendCommandToRecord(draft, command, { allowReservedPrefix: true });
        if (appendOutcome.duplicate) {
          // 幂等命中：同一 unresolved 的重复重投。必须是派生自该 unresolved
          // 的既有指令；否则键被无关命令占用（键空间保留下正常路径不可达，
          // 损坏态防御）——抛错回滚整次事务，unresolved 保持未处置。
          if (!isReissueDerivedFrom(appendOutcome.command, target)) {
            throw Object.assign(
              new Error(
                `idempotencyKey "reissue-${target.unresolvedId}" is occupied by an unrelated command ${appendOutcome.command.commandId}`,
              ),
              { code: 'inconsistent_state', status: 500 },
            );
          }
          // 命中关联正确的既有指令：以入箱实体为准返回（新建对象未入箱，
          // 作为句柄返回会造成"收口但指令不存在"的假成功）。
          reissued = appendOutcome.command;
        } else {
          reissued = command;
        }
        pruneCommands(draft);
      }

      pruneResolvedUnresolved(draft);
      pushLifecycleEvent(draft, {
        type: 'unresolved_resolved',
        status: draft.status,
        at: now,
        unresolvedId,
        resolution,
        reissuedCommandId: reissued?.commandId || null,
      });
      return draft;
    });

    return { record, command: reissued };
  }

  /**
   * 未决指令查询：open（未处置）优先按创建时间稳定排序；includeResolved
   * 时附带最近若干条已处置记录（处置历史审计，裁剪口径同 pruneResolvedUnresolved）。
   */
  async listUnresolved(
    threadId: string,
    opts: { includeResolved?: boolean } = {},
  ): Promise<WorkThreadUnresolvedCommand[]> {
    const tid = validateId(threadId, 'threadId');
    const thread = await this.store.get(tid);
    if (!thread) throw new WorkThreadNotFoundError(tid);
    const open = openUnresolvedCommands(thread);
    if (!opts.includeResolved) return open;
    const resolved = (Array.isArray(thread.unresolvedCommands) ? thread.unresolvedCommands : [])
      .filter((entry) => entry?.resolvedAt)
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(0, MAX_RETAINED_RESOLVED_UNRESOLVED);
    return [...open, ...resolved];
  }

  // ── 状态迁移（锚点收口）────────────────────────────────────────

  /**
   * 关闭只表示锚点收口 + 执行载体终态（terminal 判定），不表示编排层任务完成。
   * pending 指令随关闭一并取消。
   */
  async closeThread(threadId: string, opts: { reason?: string } = {}): Promise<WorkThreadRecord> {
    const tid = validateId(threadId, 'threadId');
    const { record } = await this.store.update(tid, (draft) => {
      const result = reduce(
        this._anchorMachine,
        draft,
        { type: 'closed', reason: cleanText(opts.reason) || 'closed' },
        { now: () => Date.now() },
      );
      // rejected 'terminal'（已 closed）= 现状幂等 no-op
      if (result.type === 'transitioned') {
        pushLifecycleEvent(draft, result.lifecycleEvent);
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
