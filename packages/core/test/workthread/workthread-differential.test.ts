/**
 * WorkThread 差分测试（PR-F3 / ADR-0021 阶段 1，实施计划 §5）。
 *
 * 形态：本文件内置 legacy 参考副本——git commit fdfcaf7（迁移前 HEAD）的
 * core.ts 六个事务体逐字拷贝为独立纯函数（仅剥离 store.update 包装与 this
 * 绑定替换为参数：continuationPolicy / identitySource / store）。迁移稳定
 * 一个版本周期后删除本文件。
 *
 * 驱动：mulberry32 固定 seed 的确定性 PRNG 生成随机事件序列，词汇
 * begin(from, reason) / fail(reason, stage, error) / advance(from, to, endKind) /
 * close(reason) / setHold(bool) / tick(delta)。fake timers 每步推进系统时钟，
 * 两侧 Date.now 完全一致，杜绝毫秒抖动。
 *
 * 身份：确定性 identitySource（池内 sessionId → 'primary'，池外 → null），
 * 使异步三道在两侧行为一致。不含 deliver（bridge I/O，已由特征测试覆盖；
 * clearStaleHandoff 因此不在差分词汇内，其等价性由 F2 用例 4 与既有
 * stale 用例锁定）。
 *
 * 对比：每步后深比较两侧 record（status / pendingSuccession / hold / commands /
 * lifecycleEvents / lastLifecycleEvent / identity / closedAt / closeReason /
 * sessionChain / headSessionId / revision），抛错对比 code。失败信息携带
 * seed / 序列号 / 步号 / 步描述，可精确复现。
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

import {
  WorkThread,
  WORKTHREAD_TERMINAL_STATUS,
  HANDOFF_STALE_MS,
  DEFAULT_SUCCESSION_INSTRUCTION,
} from '../../src/core/workthread/core.js';
import type { WorkThreadContinuationPolicy } from '../../src/core/workthread/core.js';
import type { WorkThreadRecord, WorkThreadStore } from '../../src/core/workthread/store.js';
import {
  WorkThreadNotFoundError,
  WorkThreadRevisionConflictError,
} from '../../src/core/workthread/store.js';
import {
  createCommandRecord,
  appendCommand as appendCommandToRecord,
  pruneCommands,
  WorkThreadCommandKind,
  WorkThreadCommandStatus,
} from '../../src/core/workthread/inbox.js';

// ── 差分参数（初值 200×50，超 1.5s 墙钟预算时减序列数、不减断言强度）──────

const BASE_SEED = 0x5eed_2026;
const SEQUENCES = 200;
const STEPS = 50;
const FIXED_THREAD_ID = 'diff-thread';
const START_MS = 1_700_000_000_000;

// ── 确定性 PRNG（mulberry32）与工具 ─────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 与 store.ts 同构的内容签名：revision/updatedAt 之外的字段序列化比较。 */
function threadContentSignature(record: WorkThreadRecord): string {
  const { revision: _revision, updatedAt: _updatedAt, ...rest } = record;
  return JSON.stringify(rest);
}

// ── 内存 store：镜像 WorkThreadStore 的 update 事务语义 ────────────────
// （per-thread 锁简化为顺序调用；mutFn 抛错丢弃 draft、无内容变更跳写
// revision 不递增、变更时 revision+1 / updatedAt=Date.now 与磁盘版一致）

class MemoryThreadStore {
  private master: WorkThreadRecord | null = null;

  constructor(private readonly fixedThreadId: string) {}

  async create(record: WorkThreadRecord): Promise<WorkThreadRecord> {
    const normalized = deepClone(record);
    normalized.threadId = this.fixedThreadId;
    this.master = normalized;
    return deepClone(normalized);
  }

  async get(threadId: string): Promise<WorkThreadRecord | null> {
    if (!this.master || threadId !== this.fixedThreadId) return null;
    return deepClone(this.master);
  }

  async list(): Promise<unknown[]> {
    return this.master ? [{ threadId: this.fixedThreadId }] : [];
  }

  async update(
    threadId: string,
    mutFn: (record: WorkThreadRecord) => WorkThreadRecord | null | undefined | Promise<WorkThreadRecord | null | undefined>,
    options: { expectedRevision?: number } = {},
  ): Promise<{ record: WorkThreadRecord; changed: boolean }> {
    if (!this.master || threadId !== this.fixedThreadId) {
      throw new WorkThreadNotFoundError(threadId);
    }
    if (Number.isInteger(options.expectedRevision) && this.master.revision !== options.expectedRevision) {
      throw new WorkThreadRevisionConflictError(
        threadId,
        options.expectedRevision as number,
        this.master.revision,
      );
    }
    const before = threadContentSignature(this.master);
    const snapshot = deepClone(this.master);
    let proposed: WorkThreadRecord | null | undefined;
    try {
      proposed = await mutFn(this.master);
    } catch (error) {
      this.master = snapshot; // 抛错丢弃 draft：与磁盘 store 的整体回滚语义一致
      throw error;
    }
    if (!proposed || typeof proposed !== 'object') {
      this.master = snapshot;
      throw new Error('WorkThreadStore.update mutFn must return the record');
    }
    const after = threadContentSignature(this.master);
    if (after === before) {
      return { record: deepClone(this.master), changed: false };
    }
    this.master.revision = (Number(this.master.revision) || 0) + 1;
    this.master.updatedAt = Date.now();
    return { record: deepClone(this.master), changed: true };
  }
}

// ── legacy 参考副本（git fdfcaf7 六事务体逐字拷贝）────────────────────
// 下方辅助（cleanText / pushLifecycleEventCopy / threadIdentityError）与
// 事务体文字均拷贝自迁移前 core.ts；仅 this.* 绑定换成参数。

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pushLifecycleEventCopy(
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

function threadIdentityError(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

/** beginSessionHandoff 事务体（store.update 包装剥离，参数化 policy）。 */
function legacyBegin(
  draft: WorkThreadRecord,
  threadId: string,
  normalizedFrom: string,
  normalizedReason: string,
  continuationPolicy: WorkThreadContinuationPolicy,
): WorkThreadRecord {
  if (draft.status === WORKTHREAD_TERMINAL_STATUS) {
    throw Object.assign(new Error(`WorkThread "${threadId}" is closed`), {
      code: 'thread_closed',
      status: 409,
    });
  }
  if (draft.hold === true) {
    throw Object.assign(new Error(`WorkThread "${threadId}" is held (administrative freeze)`), {
      code: 'thread_held',
      status: 409,
    });
  }
  if (
    draft.status === 'rotating'
    && draft.pendingSuccession?.startedAt
    && Date.now() - draft.pendingSuccession.startedAt < HANDOFF_STALE_MS
  ) {
    throw Object.assign(
      new Error(`WorkThread "${threadId}" already has a handoff in progress; concurrent succession requests are rejected`),
      { code: 'handoff_in_progress', status: 409 },
    );
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
  // R3：恢复指令随挡板同笔原子写入。策略抛错 = 整个 begin 失败，
  // 不留半套挡板（显式失败优于静默缺指令）。
  const instructionText = continuationPolicy.composeSuccessionInstruction({
    threadId,
    fromSessionId: normalizedFrom,
    reason: normalizedReason,
  });
  if (typeof instructionText === 'string' && instructionText.trim()) {
    const instruction = createCommandRecord({
      threadId,
      kind: WorkThreadCommandKind.SYSTEM_CONTINUATION,
      text: instructionText,
      source: 'thread-succession',
      idempotencyKey: `succession:${threadId}:${normalizedFrom}`,
    });
    instruction.createdAt = now;
    appendCommandToRecord(draft, instruction);
    pruneCommands(draft);
  }
  pushLifecycleEventCopy(draft, {
    type: 'handoff_started',
    status: 'rotating',
    at: now,
    fromSessionId: normalizedFrom,
    reason: normalizedReason,
  });
  return draft;
}

/** failSessionHandoff 事务体。 */
function legacyFail(
  draft: WorkThreadRecord,
  opts: { reason?: string; stage?: string; error?: unknown },
): WorkThreadRecord {
  if (draft.status === WORKTHREAD_TERMINAL_STATUS || !draft.pendingSuccession) {
    return draft;
  }
  draft.status = 'rotation_failed';
  draft.pendingSuccession.stage = cleanText(opts.stage) || draft.pendingSuccession.stage || 'unknown';
  pushLifecycleEventCopy(draft, {
    type: 'handoff_failed',
    status: 'rotation_failed',
    at: Date.now(),
    reason: cleanText(opts.reason) || 'handoff_failed',
    stage: cleanText(opts.stage) || 'unknown',
    error: opts.error != null ? String(opts.error) : null,
  });
  return draft;
}

/** clearStaleHandoff 事务体（差分词汇不含 deliver，此副本保持完整性）。 */
function legacyClearStale(draft: WorkThreadRecord): WorkThreadRecord {
  if (!draft.pendingSuccession) return draft;
  draft.pendingSuccession = null;
  if (draft.status === 'rotating') draft.status = 'open';
  pushLifecycleEventCopy(draft, { type: 'handoff_stale', status: draft.status, at: Date.now() });
  return draft;
}

/** setHold 事务体（hold 是伴随字段，非 status 轴转换）。 */
function legacySetHold(draft: WorkThreadRecord, wantHold: boolean): WorkThreadRecord {
  if (draft.hold === wantHold) return draft;
  draft.hold = wantHold;
  return draft;
}

/** advanceHead 事务体（含异步身份三道与成员独占）。 */
async function legacyAdvance(
  draft: WorkThreadRecord,
  ctx: {
    threadId: string;
    normalizedFrom: string;
    normalizedTo: string;
    endKind?: string;
    identitySource?: (agentId: string, sessionId: string) => Promise<string | null> | string | null;
    store: MemoryThreadStore;
  },
): Promise<WorkThreadRecord> {
  const { threadId, normalizedFrom, normalizedTo, identitySource, store } = ctx;
  if (draft.status === WORKTHREAD_TERMINAL_STATUS) {
    throw Object.assign(new Error(`WorkThread "${threadId}" is closed`), {
      code: 'thread_closed',
      status: 409,
    });
  }
  if (draft.hold === true) {
    throw Object.assign(
      new Error(`WorkThread "${threadId}" is held (administrative freeze); head cannot advance`),
      { code: 'thread_held', status: 409 },
    );
  }
  if (draft.headSessionId !== normalizedFrom) {
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

  if (identitySource) {
    const threadAgentId = cleanText(draft.agentId);
    const toIdentity = cleanText(await identitySource(threadAgentId, normalizedTo));
    if (!toIdentity) {
      throw threadIdentityError(
        `Session "${normalizedTo}" does not belong to workspace host "${threadAgentId}" of thread "${threadId}"`,
        'session_workspace_mismatch',
        409,
      );
    }
    let effectiveThreadIdentity = draft.identity;
    if (!effectiveThreadIdentity) {
      effectiveThreadIdentity =
        cleanText(await identitySource(threadAgentId, draft.rootSessionId)) || null;
      if (!effectiveThreadIdentity) {
        throw threadIdentityError(
          `Thread "${threadId}" has no identity attribution and its root session identity is unknown; backfill the root identity before advancing the head`,
          'thread_identity_missing',
          409,
        );
      }
      draft.identity = effectiveThreadIdentity;
    }
    if (toIdentity !== effectiveThreadIdentity) {
      throw threadIdentityError(
        `Session "${normalizedTo}" has identity "${toIdentity}" but thread "${threadId}" is bound to identity "${effectiveThreadIdentity}"`,
        'thread_identity_mismatch',
        409,
      );
    }
    const summaries = await store.list();
    for (const summary of summaries as Array<{ threadId?: string }>) {
      if (!summary?.threadId || summary.threadId === threadId) continue;
      const other = await store.get(summary.threadId);
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
    currentHead.endKind = cleanText(ctx.endKind) || 'manual';
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
  draft.pendingSuccession = null;
  draft.status = 'open';
  pushLifecycleEventCopy(draft, {
    type: 'handoff_completed',
    status: 'open',
    at: now,
    fromSessionId: normalizedFrom,
    toSessionId: normalizedTo,
    reason: cleanText(ctx.endKind) || 'manual',
  });
  return draft;
}

/** closeThread 事务体（isTerminal(draft) 在非空 draft 上 ≡ status === 'closed'）。 */
function legacyClose(draft: WorkThreadRecord, opts: { reason?: string }): WorkThreadRecord {
  if (draft.status === WORKTHREAD_TERMINAL_STATUS) return draft;
  draft.status = WORKTHREAD_TERMINAL_STATUS;
  draft.closedAt = Date.now();
  draft.closeReason = cleanText(opts.reason) || 'closed';
  pushLifecycleEventCopy(draft, {
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
}

// ── 差分驱动 ─────────────────────────────────────────────────────────

const SESSION_POOL = ['s-alpha', 's-beta', 's-gamma', 's-delta'] as const;
const OUT_POOL = 's-outsider';

type Step =
  | { kind: 'begin'; from: string; reason: string }
  | { kind: 'fail'; reason: string; stage: string; error?: string }
  | { kind: 'advance'; from: string; to: string; endKind: string }
  | { kind: 'close'; reason: string }
  | { kind: 'hold'; held: boolean }
  | { kind: 'tick'; delta: number };

const BEGIN_REASONS = ['manual', 'trim', 'context_guard', ''] as const;
const FAIL_REASONS = ['compact_crashed', 'retry_crashed', ''] as const;
const FAIL_STAGES = ['started', 'compact_or_successor', 'advance_head', ''] as const;
const END_KINDS = ['trim', 'manual', ''] as const;
const CLOSE_REASONS = ['user', 'head_session_deleted', ''] as const;

/**
 * 事件生成。状态感知加权：驱动读「新侧」当前 record 决定词汇分布（两侧输入
 * 恒同，差分性质不受影响）——closed 态大幅降低 begin/advance（保留少量终态
 * 映射覆盖），非终态让 from 以实际概率贴合当前 head，提高成功转换密度。
 */
function makeStep(rng: () => number, closed: boolean, headSessionId: string | null): Step {
  const rollBegin = (): Step => ({
    kind: 'begin',
    from: rng() < 0.6 && headSessionId ? headSessionId : pick(rng, SESSION_POOL),
    reason: pick(rng, BEGIN_REASONS),
  });
  const rollAdvance = (): Step => ({
    kind: 'advance',
    from: rng() < 0.6 && headSessionId ? headSessionId : pick(rng, [...SESSION_POOL, OUT_POOL]),
    to: rng() < 0.7 ? pick(rng, SESSION_POOL) : OUT_POOL,
    endKind: pick(rng, END_KINDS),
  });
  const rollFail = (): Step => ({
    kind: 'fail',
    reason: pick(rng, FAIL_REASONS),
    stage: pick(rng, FAIL_STAGES),
    ...(rng() < 0.3 ? { error: 'Error: differential boom' } : {}),
  });
  const rollHold = (): Step => ({ kind: 'hold', held: rng() < 0.5 });
  const rollTick = (): Step => ({ kind: 'tick', delta: Math.floor(rng() * 2 * HANDOFF_STALE_MS) });
  const rollClose = (): Step => ({ kind: 'close', reason: pick(rng, CLOSE_REASONS) });

  if (closed) {
    const roll = rng();
    if (roll < 0.10) return rollBegin(); // 终态保护 → thread_closed 映射仍有覆盖
    if (roll < 0.15) return rollAdvance();
    if (roll < 0.40) return rollFail();
    if (roll < 0.50) return rollClose();
    if (roll < 0.80) return rollHold();
    return rollTick();
  }
  const roll = rng();
  if (roll < 0.05) return rollTick(); // 大步进钟：跨 HANDOFF_STALE_MS 边界制造 stale/fresh 翻转
  if (roll < 0.35) return rollBegin();
  if (roll < 0.60) return rollFail();
  if (roll < 0.90) return rollAdvance();
  if (roll < 0.95) return rollClose();
  return rollHold();
}

function errorCode(error: unknown): string {
  const code = (error as { code?: string })?.code;
  return code ?? `UNCODED:${error instanceof Error ? error.message : String(error)}`;
}

type IdentitySource = (agentId: string, sessionId: string) => string | null;

function makePolicy(): WorkThreadContinuationPolicy {
  return { composeSuccessionInstruction: () => DEFAULT_SUCCESSION_INSTRUCTION };
}

function makeIdentitySource(): IdentitySource {
  return (_agentId: string, sessionId: string) =>
    (SESSION_POOL as readonly string[]).includes(sessionId) ? 'primary' : null;
}

async function applyNewSide(thread: WorkThread, step: Step): Promise<string | null> {
  try {
    switch (step.kind) {
      case 'begin':
        await thread.beginSessionHandoff({ threadId: FIXED_THREAD_ID, fromSessionId: step.from, reason: step.reason });
        return null;
      case 'fail':
        await thread.failSessionHandoff(FIXED_THREAD_ID, {
          reason: step.reason,
          stage: step.stage,
          ...(step.error !== undefined ? { error: step.error } : {}),
        });
        return null;
      case 'advance':
        await thread.advanceHead({
          threadId: FIXED_THREAD_ID,
          fromSessionId: step.from,
          toSessionId: step.to,
          endKind: step.endKind,
        });
        return null;
      case 'close':
        await thread.closeThread(FIXED_THREAD_ID, { reason: step.reason });
        return null;
      case 'hold':
        await thread.setHold(FIXED_THREAD_ID, step.held);
        return null;
      case 'tick':
        return null;
    }
  } catch (error) {
    return errorCode(error);
  }
}

async function applyLegacySide(
  store: MemoryThreadStore,
  step: Step,
  policy: WorkThreadContinuationPolicy,
  identitySource: IdentitySource,
): Promise<string | null> {
  try {
    switch (step.kind) {
      case 'begin':
        await store.update(FIXED_THREAD_ID, (draft) =>
          legacyBegin(draft, FIXED_THREAD_ID, step.from, cleanText(step.reason) || 'manual', policy));
        return null;
      case 'fail':
        await store.update(FIXED_THREAD_ID, (draft) => legacyFail(draft, {
          reason: step.reason,
          stage: step.stage,
          ...(step.error !== undefined ? { error: step.error } : {}),
        }));
        return null;
      case 'advance':
        await store.update(FIXED_THREAD_ID, (draft) => legacyAdvance(draft, {
          threadId: FIXED_THREAD_ID,
          normalizedFrom: step.from,
          normalizedTo: step.to,
          endKind: step.endKind,
          identitySource,
          store,
        }));
        return null;
      case 'close':
        await store.update(FIXED_THREAD_ID, (draft) => legacyClose(draft, { reason: step.reason }));
        return null;
      case 'hold':
        await store.update(FIXED_THREAD_ID, (draft) => legacySetHold(draft, step.held));
        return null;
      case 'tick':
        return null;
    }
  } catch (error) {
    return errorCode(error);
  }
}

function snapshotForCompare(record: WorkThreadRecord | null): unknown {
  if (!record) return null;
  return {
    status: record.status,
    headSessionId: record.headSessionId,
    pendingSuccession: record.pendingSuccession,
    hold: record.hold,
    // commandId 是 createCommandRecord 内部随机 UUID（与行为等价性无关），
    // 以 idempotencyKey + 全字段（除 commandId）保真比较
    commands: (record.commands || []).map(({ commandId: _commandId, ...rest }) => rest),
    lifecycleEvents: record.lifecycleEvents,
    lastLifecycleEvent: record.lastLifecycleEvent,
    identity: record.identity,
    closedAt: record.closedAt,
    closeReason: record.closeReason,
    sessionChain: record.sessionChain,
    revision: record.revision,
  };
}

function describeStep(step: Step): string {
  return JSON.stringify(step);
}

describe('WorkThread differential: legacy transactions vs state-kernel transition table', () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it(`random event sequences are step-by-step identical (${SEQUENCES} sequences x ${STEPS} steps, seed ${BASE_SEED})`, async () => {
    const policy = makePolicy();
    const identitySource = makeIdentitySource();
    let mutationCount = 0;
    const outcomeStats = new Map<string, number>();

    for (let seq = 0; seq < SEQUENCES; seq++) {
      const rng = mulberry32(BASE_SEED + seq);
      const tag = `seq=${seq} seed=${BASE_SEED + seq}`;

      // 双侧 bootstrap：同一 start 语义（start 不在迁移面，两侧同构构造）
      vi.setSystemTime(START_MS);
      const storeNew = new MemoryThreadStore(FIXED_THREAD_ID);
      const threadNew = new WorkThread({
        store: storeNew as unknown as WorkThreadStore,
        identitySource,
        continuationPolicy: policy,
      });
      await threadNew.start({ sessionRef: { agentId: 'diff-agent', sessionId: SESSION_POOL[0] } });

      const storeLegacy = new MemoryThreadStore(FIXED_THREAD_ID);
      await storeLegacy.create({
        threadId: FIXED_THREAD_ID,
        agentId: 'diff-agent',
        workspaceId: 'diff-agent',
        title: '',
        status: 'open',
        identity: 'primary',
        rootSessionId: SESSION_POOL[0],
        headSessionId: SESSION_POOL[0],
        sessionChain: [
          {
            sessionId: SESSION_POOL[0],
            role: 'head',
            startedAt: START_MS,
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
        createdAt: START_MS,
        updatedAt: START_MS,
      });

      let clockMs = START_MS;
      for (let stepIndex = 0; stepIndex < STEPS; stepIndex++) {
        // 状态感知词汇：读「新侧」当前状态加权分布（每步末两侧已断言相等，
        // 因此词汇生成的输入对两侧恒同，差分性质不受影响）
        const beforeNew = await storeNew.get(FIXED_THREAD_ID);
        const revisionBefore = beforeNew?.revision ?? null;
        const step = makeStep(
          rng,
          beforeNew?.status === WORKTHREAD_TERMINAL_STATUS,
          beforeNew?.headSessionId ?? null,
        );
        // 每步微推进 + tick 大跳：两侧 Date.now 完全一致
        clockMs += 1 + Math.floor(rng() * 50);
        if (step.kind === 'tick') clockMs += step.delta;
        vi.setSystemTime(clockMs);

        const outcomeNew = await applyNewSide(threadNew, step);
        const outcomeLegacy = await applyLegacySide(storeLegacy, step, policy, identitySource);

        const outcomeKey = `${step.kind} -> ${outcomeNew ?? 'ok'}`;
        outcomeStats.set(outcomeKey, (outcomeStats.get(outcomeKey) ?? 0) + 1);

        const afterNew = await storeNew.get(FIXED_THREAD_ID);
        const afterLegacy = await storeLegacy.get(FIXED_THREAD_ID);

        const at = `${tag} step=${stepIndex} ${describeStep(step)}`;
        try {
          expect(outcomeNew).toBe(outcomeLegacy);
        } catch (error) {
          throw new Error(
            `outcome mismatch at ${at}\nnew=${outcomeNew} legacy=${outcomeLegacy}\n${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          expect(snapshotForCompare(afterNew)).toEqual(snapshotForCompare(afterLegacy));
        } catch (error) {
          throw new Error(
            `record mismatch at ${at}\nnew=${JSON.stringify(afterNew, null, 2)}\nlegacy=${JSON.stringify(afterLegacy, null, 2)}\n${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (revisionBefore !== null && afterNew && afterNew.revision !== revisionBefore) {
          mutationCount++;
        }
      }
    }

    // 驱动强度自检：断言差分确实命中了 mutating 路径（防止词汇退化成全 no-op）
    expect(mutationCount).toBeGreaterThan(SEQUENCES * STEPS * 0.05);

    // 驱动强度输出（可复现：seed + 步号；供维护者核对词汇覆盖）
    console.log(
      `[differential] ${SEQUENCES} sequences x ${STEPS} steps, mutations=${mutationCount}, ` +
        `outcomes=${JSON.stringify(Object.fromEntries([...outcomeStats.entries()].sort()))}`,
    );
  });
});
