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

export const WorkThreadCommandKind = Object.freeze({
  USER_MESSAGE: 'user_message',
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
  };
}

/**
 * 幂等追加指令。若 idempotencyKey 命中既有的 pending / delivered
 * 指令，直接返回既有指令（重复提交不产生副作用）。
 * @returns {{command: WorkThreadCommand, duplicate: boolean}}
 */
export function appendCommand(
  record: { commands?: WorkThreadCommand[] },
  command: WorkThreadCommand,
): { command: WorkThreadCommand; duplicate: boolean } {
  const commands = Array.isArray(record.commands) ? record.commands : [];
  record.commands = commands;

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
 * @returns 是否有被裁掉的（内容变更）
 */
export function pruneCommands(
  record: { commands?: WorkThreadCommand[] },
  maxRetained: number = MAX_RETAINED_TERMINAL_COMMANDS,
): boolean {
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  const terminal = commands.filter((c) => TERMINAL_STATUSES.has(c?.status));
  if (terminal.length <= maxRetained) return false;

  const dropSet = new Set(
    terminal
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(maxRetained)
      .map((c) => c.commandId),
  );
  record.commands = commands.filter((c) => !dropSet.has(c.commandId));
  return true;
}
