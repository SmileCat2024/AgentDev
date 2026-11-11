/**
 * WorkThread Inbox — WorkThread 级待投递指令（纯函数层）
 *
 * 移植自 Claw `server/thread-control/thread-inbox.js`（幂等入队 / 稳定排序 /
 * 终态裁剪）。语义定位：这条指令属于某项连续工作（WorkThread），而不属于某个
 * 可能被替换的 runtime。指令先持久化（pending），由 WorkThread 在当前承接会话
 * 可用时经 bridge 下沉为 runtime envelope（delivered）。
 *
 * 本模块不持有状态、不做 IO；所有操作作用于 thread record 的 `commands` 数组，
 * 由 WorkThreadStore 的原子写保证持久化。
 *
 * 不承诺 LLM 副作用 exactly-once：只承诺命令身份持久化 + 幂等入队 + 可追踪的
 * 投递状态。真实世界副作用由新会话核对现实状态后继续。
 *
 * ADR-0047 阶段 2（本文件下半部分）：接续时无法判定消费的退役棒指令成为
 * 一等持久事实（unresolved）。分类证据经宿主以类型化快照注入（框架锚点层
 * 不 import 看板模块）；缺消费引用不构成未消费证明——无法判定转为
 * unresolved 记录，不得自动重放、不得静默滞留、不得被终态裁剪删除。
 */

import { randomUUID } from 'crypto';

export const WorkThreadCommandStatus = Object.freeze({
  PENDING: 'pending',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const);

export type WorkThreadCommandStatusValue = (typeof WorkThreadCommandStatus)[keyof typeof WorkThreadCommandStatus];

export type WorkThreadCommandStatusName = keyof typeof WorkThreadCommandStatus;

const TERMINAL_STATUSES = new Set<string>([
  WorkThreadCommandStatus.DELIVERED,
  WorkThreadCommandStatus.FAILED,
  WorkThreadCommandStatus.CANCELLED,
]);

/**
 * 指令 kind 的官方封闭词表。前两个是 turn 身份槽位（ADR-0024 决策 3：
 * 用户消息与定时唤醒提醒共用线程行政检查，身份随投递链路原样转发）；
 * 后两个是指令来源分类。appendCommand 对未知值显式拒绝（见 core.ts）。
 */
export const WorkThreadCommandKind = Object.freeze({
  USER_MESSAGE: 'user_message',
  REMINDER: 'reminder',
  SYSTEM_CONTINUATION: 'system_continuation',
  EXTERNAL: 'external',
} as const);

export type WorkThreadCommandKindValue = (typeof WorkThreadCommandKind)[keyof typeof WorkThreadCommandKind];

/** 终态指令保留上限（超出按时间裁剪，防止 commands 无限增长） */
export const MAX_RETAINED_TERMINAL_COMMANDS = 200;

export function generateCommandId(): string {
  return `cmd-${randomUUID()}`;
}

export interface WorkThreadCommand {
  commandId: string;
  threadId: string;
  kind: string;
  text: string;
  source: string;
  idempotencyKey: string;
  status: WorkThreadCommandStatusValue;
  attempts: number;
  envelopeId: string | null;
  lastReason: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  deliveryRef?: string | null;
  /** 随指令流动的能力激活通知（capability refs），投递时随 user-turn 元数据转发 */
  capabilityActivations?: string[];
  /** 随指令流动的图片引用（附件名/路径/URL），投递时转发给 viewer user-turn */
  images?: string[];
  /** 随指令流动的 user-turn 自由元数据（框架只透传不解释，key 由消费方命名空间化） */
  metadata?: Record<string, unknown>;
  /**
   * 来源侧引用（ADR-0031 步骤一）：本指令由携带 sourceRef 的输入进入线程域
   * 时随行记录该原始事件引用（如唤醒 reminder 的事件 ID）。框架只透传不解释；
   * 宿主观察器据此把"线程域内换得新 commandId 的指令"关联回它进入前的
   * 来源侧事件/工作标识。缺省表示指令不经引用携带进入（如直接派发）。
   */
  originSourceRef?: string;
}

// ── ADR-0047 阶段 2：接续消费证据分类 + unresolved 一等事实 ──────────

/**
 * 证据完整性（看板读态的结构化区分；文件缺失与解析失败不再是同一个 null）。
 * unreadable = 读取本身抛错（瞬时 IO 故障，重试可恢复证据）——语义决策归
 * commit 层（拒绝换头、可重试），不混入 missing/corrupt 的 unresolved 承接
 * （ADR-0047 阶段 2a 审查裁定：读取失败与证据缺失分离）。
 */
export type SuccessionEvidenceIntegrity = 'ok' | 'missing' | 'corrupt' | 'unreadable';

/**
 * 退役棒消费证据的类型化快照。宿主在接续事务外从看板读取后注入——锚点层
 * 刻意不 import 看板模块（观察层隔离），此处只约定结构兼容的形状。
 *
 * 读取时点在事务提交前存在窗口：迟到事件只可能把「无法判定」升级为
 * 「已消费」（正向引用只增不减），分类结果是单向保守的——错过迟到引用
 * 最多多建一条 unresolved（显式处置可收敛），绝不会把已消费误判为未消费
 * 或反向。这是证据可以事务外读取的前提。
 */
export interface SuccessionEvidence {
  integrity: SuccessionEvidenceIntegrity;
  /**
   * integrity === 'ok' 时的看板 executionEvents 保留窗口（原始 entry 数组，
   * 结构兼容即可）。missing / corrupt 时忽略本字段。
   */
  events: ReadonlyArray<{ sessionId?: string; event?: Record<string, unknown> }>;
  /** 完整性问题的说明（corrupt 的解析错误等），只进审计不参与判定。 */
  note?: string;
}

/** 证据分类产出的无法判定原因（稳定 code，落进 unresolved.reason 供处置方分流）。 */
export const WORKTHREAD_SUCCESSION_REASONS = Object.freeze({
  /** 看板状态文件缺失（从未创建 / 被隔离），证据整体不可用。 */
  EVIDENCE_MISSING: 'evidence_missing',
  /** 看板状态文件存在但解析失败（损坏），证据整体不可用。 */
  EVIDENCE_CORRUPT: 'evidence_corrupt',
  /** 证据可用，但保留窗口里看不到退役棒的任何事件（整棒被裁剪 / 上报失败）。 */
  NO_EVENTS_FOR_BAR: 'no_events_for_bar',
  /** 退役棒事件可见，但该指令没有任何可靠消费引用（缺引用 ≠ 未消费）。 */
  NO_POSITIVE_REFERENCE: 'no_positive_reference',
  /**
   * delivered 但缺少可解析的投递时间：无法归属到任何棒窗口（不属于退役
   * 棒，也不该算当前棒）。静默跳过会让它永远不被分类、迟早被终态裁剪
   * ——ADR-0047「未分类 delivered 不得被终态裁剪」，按无法判定显式转
   * unresolved（挂本次接续处置）。
   */
  UNATTRIBUTABLE: 'unattributable',
} as const);

export type WorkThreadSuccessionReasonValue =
  (typeof WORKTHREAD_SUCCESSION_REASONS)[keyof typeof WORKTHREAD_SUCCESSION_REASONS];

/**
 * unresolved 一等事实（ADR-0047 决策 4）：接续时无法判定消费的退役棒指令，
 * 以完整载荷持久化在线程记录本体（与 head 推进同一次原子写）。处置
 * （consumed / reissue / discard）是显式决定，不是推断——自动重放被禁止。
 */
export interface WorkThreadUnresolvedCommand {
  unresolvedId: string;
  /** 来源指令身份（该指令本体保持 delivered 终态，本记录是它的未决侧写）。 */
  commandId: string;
  threadId: string;
  /** 以下为来源指令的完整载荷快照：处置（reissue）不依赖原指令仍在 commands 里。 */
  kind: string;
  text: string;
  source: string;
  idempotencyKey: string;
  capabilityActivations?: string[];
  images?: string[];
  metadata?: Record<string, unknown>;
  originSourceRef?: string;
  /** 退役棒（指令投递落点）的 sessionId，处置方核对历史的寻址锚。 */
  fromHeadSessionId: string;
  /** 无法判定原因（WORKTHREAD_SUCCESSION_REASONS 稳定 code）。 */
  reason: string;
  createdAt: number;
  /** 处置事实：null = open；非 null = 已按该方式收口。 */
  resolvedAt: number | null;
  resolution: null | 'consumed' | 'reissue' | 'discard';
  resolutionNote: string | null;
  updatedAt: number;
}

export function generateUnresolvedId(): string {
  return `unres-${randomUUID()}`;
}

/** thread record 上 unresolved 数组的防御读取（旧记录无此字段）。 */
function unresolvedCommandsOf(
  record: { unresolvedCommands?: unknown },
): WorkThreadUnresolvedCommand[] {
  return Array.isArray(record?.unresolvedCommands)
    ? (record.unresolvedCommands as WorkThreadUnresolvedCommand[])
    : [];
}

/**
 * 当前 head 棒（chain 中 headSessionId 对应、未收口条目）的 startedAt。
 * 返回 null 表示 head 条目不在 chain 上（数据异常）：pruneCommands 据此
 * 保守豁免全部 delivered——未分类指令被裁掉即永久丢失恢复依据（ADR-0047
 * 核心承诺），宁可容忍 commands 增长（可观测、可运维）。
 */
function headBarStartedAt(record: {
  headSessionId?: string;
  sessionChain?: Array<{ sessionId?: string; startedAt?: number; endedAt?: number | null }>;
}): number | null {
  const chain = Array.isArray(record?.sessionChain) ? record.sessionChain : [];
  const headId = typeof record?.headSessionId === 'string' ? record.headSessionId : '';
  const bar = chain.find((entry) => entry?.sessionId === headId);
  if (!bar) return null;
  return Number(bar?.startedAt) || 0;
}

/**
 * 退役棒指令消费证据分类（ADR-0047 决策 2 的框架实现，语义与宿主判定闸同源）。
 *
 * 候选集 = delivered、非接续（system_continuation 由接续链路独占）、投递时间
 * 落在退役棒存续窗 [startedAt, endedAt] 内（归属用时间窗而非 deliveryRef——
 * 后者是 runtime 标识，与 sessionId 不同源）。消费证明 = 退役棒 turn.* 事件
 * 携带的可靠引用（当前轮 sourceRef、忙时 consumedSourceRefs、终态事件引用
 * ——completed / cancelled / failed 只描述轮次结果，不撤销输入已进入旧会话
 * 上下文的事实）。缺引用不构成未消费证明：无法判定的指令进 undecidable，
 * 由调用方在接续事务内转为 unresolved 持久事实。
 *
 * @returns consumedCommandIds 有可靠消费引用的指令（保持 delivered 终态）；
 *          undecidable 无法判定的指令及其稳定原因 code。
 */
export function classifyRetiredCommands(
  record: {
    commands?: WorkThreadCommand[];
    sessionChain?: Array<{ sessionId?: string; startedAt?: number; endedAt?: number | null }>;
  },
  retiredSessionId: string,
  evidence: SuccessionEvidence,
): {
  consumedCommandIds: string[];
  undecidable: Array<{ command: WorkThreadCommand; reason: WorkThreadSuccessionReasonValue }>;
} {
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  const chain = Array.isArray(record?.sessionChain) ? record.sessionChain : [];
  const bar = chain.find((entry) => entry?.sessionId === retiredSessionId);
  // 退役棒不在 chain 上是调用方契约错误（fromSessionId 必须是 chain 成员）：
  // 显式拒绝而不是按无限时间窗扩大候选集（无限窗口会把不相关棒的老指令
  // 全部误判为待分类，制造无关 unresolved）。
  if (!bar) {
    const error = new Error(
      `retired bar ${retiredSessionId} not found in sessionChain (fromSessionId must be a chain member)`,
    );
    (error as Error & { code?: string }).code = 'invalid_retired_bar';
    throw error;
  }
  // unreadable 的语义决策（可重试失败）归 commit 层；纯函数收到它属于调用
  // 方漏检，按契约违规拒绝而不是静默当作证据缺失。
  if (evidence?.integrity === 'unreadable') {
    const error = new Error(
      'unreadable evidence must be handled by the commit layer (retryable failure), not classified',
    );
    (error as Error & { code?: string }).code = 'invalid_evidence_integrity';
    throw error;
  }
  const barStart = Number(bar?.startedAt) || 0;
  const barEnd = Number(bar?.endedAt) || Infinity;

  const candidates: WorkThreadCommand[] = [];
  const unattributable: Array<{ command: WorkThreadCommand; reason: WorkThreadSuccessionReasonValue }> = [];
  for (const command of commands) {
    if (command?.status !== WorkThreadCommandStatus.DELIVERED) continue;
    if (command.kind === WorkThreadCommandKind.SYSTEM_CONTINUATION) continue;
    const deliveredAt = Number(command.deliveredAt) || 0;
    if (!deliveredAt) {
      unattributable.push({ command, reason: WORKTHREAD_SUCCESSION_REASONS.UNATTRIBUTABLE });
      continue;
    }
    if (deliveredAt < barStart || deliveredAt > barEnd) continue;
    candidates.push(command);
  }
  if (candidates.length === 0) return { consumedCommandIds: [], undecidable: unattributable };

  // 有待判定指令：证据成为必要。整体不可用 → 全部无法判定。
  if (evidence?.integrity !== 'ok') {
    const reason = evidence?.integrity === 'corrupt'
      ? WORKTHREAD_SUCCESSION_REASONS.EVIDENCE_CORRUPT
      : WORKTHREAD_SUCCESSION_REASONS.EVIDENCE_MISSING;
    return { consumedCommandIds: [], undecidable: [...unattributable, ...candidates.map((command) => ({ command, reason }))] };
  }

  const entries = Array.isArray(evidence.events) ? evidence.events : [];
  const consumed = new Set<string>();
  let touched = false;
  for (const entry of entries) {
    if (entry?.sessionId !== retiredSessionId) continue;
    touched = true;
    const event = entry?.event;
    if (event?.type !== 'turn.started' && event?.type !== 'turn.completed'
      && event?.type !== 'turn.continued' && event?.type !== 'turn.cancelled'
      && event?.type !== 'turn.failed') continue;
    for (const ref of [event.sourceRef, ...(event.consumedSourceRefs || [])]) {
      if (typeof ref === 'string' && ref) consumed.add(ref);
    }
  }
  // 证据可用但保留窗口里看不到这一棒：整棒被裁剪 / 上报失败，全部无法判定。
  if (!touched) {
    return {
      consumedCommandIds: [],
      undecidable: [
        ...unattributable,
        ...candidates.map((command) => ({
          command,
          reason: WORKTHREAD_SUCCESSION_REASONS.NO_EVENTS_FOR_BAR,
        })),
      ],
    };
  }

  const consumedCommandIds: string[] = [];
  const undecidable: Array<{ command: WorkThreadCommand; reason: WorkThreadSuccessionReasonValue }> = [...unattributable];
  for (const command of candidates) {
    if (consumed.has(command.commandId)) {
      consumedCommandIds.push(command.commandId);
    } else {
      undecidable.push({
        command,
        reason: WORKTHREAD_SUCCESSION_REASONS.NO_POSITIVE_REFERENCE,
      });
    }
  }
  return { consumedCommandIds, undecidable };
}

/** 从无法判定的指令构造 unresolved 记录（不改 thread record）。 */
export function createUnresolvedRecord(
  command: WorkThreadCommand,
  fromHeadSessionId: string,
  reason: string,
): WorkThreadUnresolvedCommand {
  const now = Date.now();
  return {
    unresolvedId: generateUnresolvedId(),
    commandId: command.commandId,
    threadId: command.threadId,
    kind: command.kind,
    text: command.text,
    source: command.source,
    idempotencyKey: command.idempotencyKey,
    ...(Array.isArray(command.capabilityActivations) && command.capabilityActivations.length > 0
      ? { capabilityActivations: [...command.capabilityActivations] }
      : {}),
    ...(Array.isArray(command.images) && command.images.length > 0
      ? { images: [...command.images] }
      : {}),
    ...(command.metadata && typeof command.metadata === 'object' && !Array.isArray(command.metadata)
      && Object.keys(command.metadata).length > 0
      // 深拷贝：浅拷会让调用方对原指令 metadata 的原地修改穿透进快照，
      // 处置（reissue）可能带出被篡改后的载荷（阶段 2a 审查裁定）。
      ? { metadata: structuredClone(command.metadata) }
      : {}),
    ...(typeof command.originSourceRef === 'string' && command.originSourceRef
      ? { originSourceRef: command.originSourceRef }
      : {}),
    fromHeadSessionId,
    reason,
    createdAt: now,
    resolvedAt: null,
    resolution: null,
    resolutionNote: null,
    updatedAt: now,
  };
}

/** open（未处置）unresolved 记录，按 createdAt 稳定排序。 */
export function openUnresolvedCommands(
  record: { unresolvedCommands?: unknown },
): WorkThreadUnresolvedCommand[] {
  return unresolvedCommandsOf(record)
    .filter((u) => u && !u.resolvedAt)
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.unresolvedId < b.unresolvedId ? -1 : 1));
}

/** 已处置 unresolved 记录的保留上限（open 永不裁剪，对齐终态命令口径）。 */
export const MAX_RETAINED_RESOLVED_UNRESOLVED = 200;

/**
 * 裁剪已处置的 unresolved 记录，保留最近 maxRetained 条。open 永不裁剪。
 * @returns 是否有被裁掉的（内容变更）
 */
export function pruneResolvedUnresolved(
  record: { unresolvedCommands?: unknown },
  maxRetained: number = MAX_RETAINED_RESOLVED_UNRESOLVED,
): boolean {
  const all = unresolvedCommandsOf(record);
  const resolved = all.filter((u) => u && u.resolvedAt);
  if (resolved.length <= maxRetained) return false;
  const dropSet = new Set(
    resolved
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(maxRetained)
      .map((u) => u.unresolvedId),
  );
  record.unresolvedCommands = all.filter((u) => !dropSet.has(u?.unresolvedId));
  return true;
}

/**
 * 构造新指令记录（不修改 thread record）。
 */
export function createCommandRecord(opts: {
  threadId: string;
  kind?: string;
  text?: string;
  source?: string;
  idempotencyKey?: string;
  capabilityActivations?: string[];
  images?: string[];
  metadata?: Record<string, unknown>;
  originSourceRef?: string;
}): WorkThreadCommand {
  const now = Date.now();
  return {
    commandId: generateCommandId(),
    threadId: opts.threadId || '',
    kind: opts.kind || WorkThreadCommandKind.USER_MESSAGE,
    text: typeof opts.text === 'string' ? opts.text : '',
    source: opts.source || 'ui',
    idempotencyKey: opts.idempotencyKey || '',
    status: WorkThreadCommandStatus.PENDING,
    attempts: 0,
    envelopeId: null,
    lastReason: null,
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
    ...(Array.isArray(opts.capabilityActivations) && opts.capabilityActivations.length > 0
      ? { capabilityActivations: opts.capabilityActivations.filter((a) => typeof a === 'string') }
      : {}),
    ...(Array.isArray(opts.images) && opts.images.filter((i) => typeof i === 'string' && i.length > 0).length > 0
      ? { images: opts.images.filter((i) => typeof i === 'string' && i.length > 0) }
      : {}),
    ...(opts.metadata && typeof opts.metadata === 'object' && !Array.isArray(opts.metadata)
      && Object.keys(opts.metadata).length > 0
      ? { metadata: opts.metadata }
      : {}),
    ...(typeof opts.originSourceRef === 'string' && opts.originSourceRef
      ? { originSourceRef: opts.originSourceRef }
      : {}),
  };
}

/**
 * 幂等键保留前缀：`reissue-<unresolvedId>` 由 resolveUnresolved 的重投
 * 路径独占。普通入箱命令禁用该前缀，否则调用方可预先占用某个 unresolved
 * 的重投键——append 幂等去重会命中那条无关命令，而重投新命令静默不入箱，
 * unresolved 却被收口（键空间隔离让这类冲突在结构上不可能发生）。
 */
export const RESERVED_IDEMPOTENCY_PREFIX = 'reissue-';

export interface AppendCommandOptions {
  /** 重投路径专用豁免：允许使用保留前缀的幂等键。 */
  allowReservedPrefix?: boolean;
}

/**
 * 幂等追加指令。若 idempotencyKey 命中既有的 pending / delivered
 * 指令，直接返回既有指令（重复提交不产生副作用）。
 *
 * 非豁免路径的幂等键不得使用保留前缀（见 RESERVED_IDEMPOTENCY_PREFIX）；
 * 违规在入箱前抛 invalid_request，由 store.update 回滚整次追加。
 * @returns {{command: WorkThreadCommand, duplicate: boolean}}
 */
export function appendCommand(
  record: { commands?: WorkThreadCommand[] },
  command: WorkThreadCommand,
  options?: AppendCommandOptions,
): { command: WorkThreadCommand; duplicate: boolean } {
  const commands = Array.isArray(record.commands) ? record.commands : [];
  record.commands = commands;

  if (
    command.idempotencyKey &&
    !options?.allowReservedPrefix &&
    command.idempotencyKey.startsWith(RESERVED_IDEMPOTENCY_PREFIX)
  ) {
    throw Object.assign(
      new Error(
        `idempotencyKey prefix "${RESERVED_IDEMPOTENCY_PREFIX}" is reserved for reissue resolution: ${command.idempotencyKey}`,
      ),
      { code: 'invalid_request', status: 400 },
    );
  }

  if (command.idempotencyKey) {
    const existing = commands.find(
      (c) =>
        c.idempotencyKey === command.idempotencyKey &&
        (c.status === WorkThreadCommandStatus.PENDING ||
          c.status === WorkThreadCommandStatus.DELIVERED),
    );
    if (existing) {
      return { command: existing, duplicate: true };
    }
  }

  commands.push(command);
  return { command, duplicate: false };
}

/** 按 createdAt + commandId 稳定排序的 pending 指令。 */
export function pendingCommands(record: { commands?: WorkThreadCommand[] }): WorkThreadCommand[] {
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  return commands
    .filter((c) => c?.status === WorkThreadCommandStatus.PENDING)
    .sort((a, b) => a.createdAt - b.createdAt || (a.commandId < b.commandId ? -1 : 1));
}

export function findCommand(
  record: { commands?: WorkThreadCommand[] },
  commandId: string,
): WorkThreadCommand | null {
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  return commands.find((c) => c?.commandId === commandId) || null;
}

/**
 * 裁剪终态指令，保留最近 maxRetained 条。pending 永不裁剪。
 *
 * ADR-0047 阶段 2 豁免（不可裁剪，裁掉即丢失待核对事实的载荷）：
 *   - 被 open（未处置）unresolved 记录引用的命令；
 *   - 当前 head 棒窗口内的 delivered 命令——它们尚未经过任何接续分类，
 *     分类机会在下一次换头，提前裁掉会让那次分类看不到候选。
 * 已分类（已退役棒且无 open unresolved 引用）的 delivered 照旧可裁。
 *
 * @returns 是否有被裁掉的（内容变更）
 */
export function pruneCommands(
  record: {
    commands?: WorkThreadCommand[];
    headSessionId?: string;
    sessionChain?: Array<{ sessionId?: string; startedAt?: number; endedAt?: number | null }>;
    unresolvedCommands?: unknown;
  },
  maxRetained: number = MAX_RETAINED_TERMINAL_COMMANDS,
): boolean {
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  const terminal = commands.filter((c) => TERMINAL_STATUSES.has(c?.status));
  if (terminal.length <= maxRetained) return false;

  const exempt = new Set<string>();
  for (const unresolved of unresolvedCommandsOf(record)) {
    if (unresolved && !unresolved.resolvedAt) exempt.add(unresolved.commandId);
  }
  const headStart = headBarStartedAt(record);
  const prunable = terminal.filter((c) => {
    if (exempt.has(c?.commandId)) return false;
    if (c?.status === WorkThreadCommandStatus.DELIVERED) {
      // 当前 head 棒的 delivered（未分类）不裁：裁掉待分类指令 = 永久丢失
      // 恢复依据（ADR-0047 核心承诺）。chain 数据异常（head 条目缺失，
      // headStart = null）或 bar 存在但 startedAt 缺失（窗口起点 0）时
      // 同样保守豁免——commands 增长可观测可运维，恢复依据丢失不可逆。
      if (headStart === null) return false;
      const deliveredAt = Number(c.deliveredAt) || 0;
      // deliveredAt 缺失/不可解析：无法归属任何棒窗口，等待下一次接续
      // 分类转 unresolved（reason=unattributable）——同 chain 异常口径
      // 保守豁免，不提前裁掉恢复依据。
      if (!deliveredAt) return false;
      if (deliveredAt >= headStart) return false;
    }
    return true;
  });
  if (prunable.length <= maxRetained) return false;

  const dropSet = new Set(
    prunable
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(maxRetained)
      .map((c) => c.commandId),
  );
  record.commands = commands.filter((c) => !dropSet.has(c.commandId));
  return true;
}
