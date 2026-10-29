/**
 * Trim-Transcript 官方变换（ticket 006 下沉自 Claw）。
 *
 * 策略引擎：对源会话快照的 messages 施加一次「裁剪 + 工具活动折叠」变换，
 * 产出下一个 Session 的种子消息（与 Claw `handoff-package.js` 的策略引擎
 * 逐字节等价——golden 对照以 Claw 现行测试数据验收）。
 *
 * 本模块只实现纯策略（DEFAULT_EXPORT_POLICY / normalizeExportPolicy /
 * buildTrimmedSeedMessages）+ 一个实现 005 Transformation 契约的
 * `TrimTranscriptTransformation`。宿主侧的写盘、文件路径等职责不在此处。
 */

import type { AgentSessionSnapshot } from '../../session-store.js';
import type { JsonValue } from '../../types.js';
import type {
  SessionTransformation,
  TransformInput,
  TransformContext,
  SuccessorSeed,
  SeedBoundary,
  SessionSeedMessage,
} from '../index.js';

// ============ 常量与默认策略 ============

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_COMPILER_VERSION = 'trim-transcript-v1';

export const DEFAULT_EXPORT_POLICY = {
  strategy: 'trim-transcript',
  includeSystemMessages: false,
  keepSystemTags: ['folded-tool-activity'],
  messageRules: [],
  includeUserMessages: true,
  includeAssistantMessages: true,
  keepRecentTurns: null,
  fullPreserveFromTurn: null,
  preservedTurns: null,
  preservedMsgRanges: null,
  assistantToolCallMode: 'fold',
  toolMessageMode: 'fold',
  toolFoldScope: 'all',
  toolFoldRecentTurns: null,
  foldConsecutiveToolActivity: true,
  foldedToolNoteRole: 'system',
  foldToolCallArgs: false,
  foldToolResultSummary: false,
  maxFoldedToolChars: 240,
  preserveToolNames: [],
};

const VALID_TOOL_MODES = new Set(['keep', 'drop', 'fold']);
const VALID_TOOL_SCOPES = new Set(['all', 'recent']);
const VALID_FOLDED_NOTE_ROLES = new Set(['system', 'assistant']);

// ============ 清洗工具（与 Claw 逐字节一致） ============

function sanitizeFragment(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function cleanInlineText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function cleanMultilineText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());
  const compacted: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1;
      if (blankRun <= 1) {
        compacted.push('');
      }
      continue;
    }
    blankRun = 0;
    compacted.push(line);
  }
  return compacted.join('\n').trim();
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeNullableTurnCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return clampInteger(value, 1, 1, 2000);
}

function normalizeNullableTurnIndex(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return clampInteger(value, 0, 0, 2000);
}

function normalizeKeepRecentCount(value: unknown): number | null | typeof Infinity {
  if (value === null || value === undefined || value === '' || value === false) return null;
  if (value === Infinity || value === 'Infinity') return Infinity;
  return clampInteger(value as number, 1, 1, 2000);
}

function normalizeToolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanInlineText).filter(Boolean))];
}

function normalizeMessageRules(value: unknown): Array<{ role?: string; source?: string; tag?: JsonValue; action: 'keep' }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: any) => {
    if (!raw || typeof raw !== 'object' || raw.action !== 'keep') return [];
    const rule: { role?: string; source?: string; tag?: JsonValue; action: 'keep' } = { action: 'keep' };
    if (typeof raw.role === 'string' && raw.role.trim()) rule.role = raw.role.trim();
    if (typeof raw.source === 'string' && raw.source.trim()) rule.source = raw.source.trim();
    if (Object.prototype.hasOwnProperty.call(raw, 'tag')) rule.tag = raw.tag;
    if (rule.role === undefined && rule.source === undefined && rule.tag === undefined) return [];
    return [rule];
  });
}

function normalizeKeepSystemTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_EXPORT_POLICY.keepSystemTags];
  return [...new Set(value.map(cleanInlineText).filter(Boolean))];
}

function normalizeEnum(value: unknown, validValues: Set<string>, fallback: string): string {
  const text = cleanInlineText(value);
  return validValues.has(text) ? text : fallback;
}

// ============ 策略归一化 ============

export interface TrimExportPolicy {
  strategy: 'trim-transcript';
  includeSystemMessages: boolean;
  keepSystemTags: string[];
  includeUserMessages: boolean;
  includeAssistantMessages: boolean;
  keepRecentTurns: number | null;
  fullPreserveFromTurn: number | null;
  preservedTurns: number[] | null;
  preservedMsgRanges: Array<[number, number]> | null;
  assistantToolCallMode: string;
  toolMessageMode: string;
  toolFoldScope: string;
  toolFoldRecentTurns: number | null;
  foldConsecutiveToolActivity: boolean;
  foldedToolNoteRole: string;
  foldToolCallArgs: boolean;
  foldToolResultSummary: boolean;
  maxFoldedToolChars: number;
  keepRecentSkillInvokes?: number | null | typeof Infinity;
  /**
   * 保护最近 N 次工具调用对（任意工具名；assistant 调用 + 按 toolCallId
   * 配对的 tool 结果原样保留，其余照常按 fold/drop 处理）。与
   * keepRecentSkillInvokes（按轮保护技能调用）和 preserveToolNames（按名
   * 全量保护）取并集。null = 不启用（默认）。
   */
  keepRecentToolCalls?: number | null | typeof Infinity;
  /** 通用消息裁决规则；rule 可按 role/source/tag 匹配，当前仅支持 keep。 */
  messageRules?: Array<{ role?: string; source?: string; tag?: JsonValue; action: 'keep' }>;
  preserveToolNames: string[];
}

export function normalizeExportPolicy(rawPolicy: Record<string, unknown> = {}): TrimExportPolicy {
  return {
    strategy: 'trim-transcript',
    includeSystemMessages: rawPolicy?.includeSystemMessages === true,
    keepSystemTags: normalizeKeepSystemTags(rawPolicy?.keepSystemTags),
    messageRules: normalizeMessageRules(rawPolicy?.messageRules),
    includeUserMessages: rawPolicy?.includeUserMessages !== false,
    includeAssistantMessages: rawPolicy?.includeAssistantMessages !== false,
    keepRecentTurns: normalizeNullableTurnCount(rawPolicy?.keepRecentTurns as unknown),
    fullPreserveFromTurn: normalizeNullableTurnIndex(rawPolicy?.fullPreserveFromTurn as unknown),
    preservedTurns: Array.isArray(rawPolicy?.preservedTurns)
      ? [...new Set((rawPolicy.preservedTurns as unknown[]).filter(t => Number.isFinite(t)).map(Number))]
      : null,
    preservedMsgRanges: Array.isArray(rawPolicy?.preservedMsgRanges) && (rawPolicy.preservedMsgRanges as unknown[]).length > 0
      ? (rawPolicy.preservedMsgRanges as Array<[unknown, unknown]>)
          .filter(r => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]))
          .map(([s, e]) => [Math.floor(s as number), Math.floor(e as number)])
      : null,
    assistantToolCallMode: normalizeEnum(rawPolicy?.assistantToolCallMode, VALID_TOOL_MODES, DEFAULT_EXPORT_POLICY.assistantToolCallMode),
    toolMessageMode: normalizeEnum(rawPolicy?.toolMessageMode, VALID_TOOL_MODES, DEFAULT_EXPORT_POLICY.toolMessageMode),
    toolFoldScope: normalizeEnum(rawPolicy?.toolFoldScope, VALID_TOOL_SCOPES, DEFAULT_EXPORT_POLICY.toolFoldScope),
    toolFoldRecentTurns: normalizeNullableTurnCount(rawPolicy?.toolFoldRecentTurns as unknown),
    foldConsecutiveToolActivity: rawPolicy?.foldConsecutiveToolActivity !== false,
    foldedToolNoteRole: normalizeEnum(rawPolicy?.foldedToolNoteRole, VALID_FOLDED_NOTE_ROLES, DEFAULT_EXPORT_POLICY.foldedToolNoteRole),
    foldToolCallArgs: rawPolicy?.foldToolCallArgs === true,
    foldToolResultSummary: rawPolicy?.foldToolResultSummary === true,
    maxFoldedToolChars: clampInteger(rawPolicy?.maxFoldedToolChars as unknown, DEFAULT_EXPORT_POLICY.maxFoldedToolChars, 80, 4000),
    keepRecentSkillInvokes: normalizeKeepRecentCount(rawPolicy?.keepRecentSkillInvokes as unknown),
    keepRecentToolCalls: normalizeKeepRecentCount(rawPolicy?.keepRecentToolCalls as unknown),
    preserveToolNames: normalizeToolNameList(rawPolicy?.preserveToolNames),
  };
}

// ============ 策略引擎（与 handoff-package.js 逐字节一致） ============

function safeJsonSnippet(value: unknown, maxChars: number): string {
  try {
    const text = cleanMultilineText(typeof value === 'string' ? value : JSON.stringify(value));
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 18)).trimEnd()} [truncated]` : text;
  } catch {
    const text = cleanMultilineText(String(value ?? ''));
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 18)).trimEnd()} [truncated]` : text;
  }
}

function extractToolCallKeyInfo(name: string, rawArgs: unknown): string | null {
  let args = rawArgs;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  if (name === 'read' || name === 'edit' || name === 'write') {
    const filePath = typeof record.filePath === 'string' ? record.filePath : '';
    if (filePath) {
      const baseName = filePath.split(/[\\/]/).pop() || filePath;
      return `${name}(${baseName})`;
    }
  }
  if (name === 'invoke_skill') {
    const skill = typeof record.skill === 'string' ? record.skill : '';
    if (skill) return `invoke_skill(${skill})`;
  }
  return null;
}

function summarizeAssistantToolCalls(toolCalls: unknown[], policy: TrimExportPolicy): string[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map((call) => {
    const name = cleanInlineText((call as Record<string, unknown>)?.name) || 'tool';
    const keyInfo = extractToolCallKeyInfo(name, (call as Record<string, unknown>)?.args ?? (call as Record<string, unknown>)?.arguments);
    if (keyInfo) return keyInfo;
    if (!policy.foldToolCallArgs) {
      return name;
    }
    const args = safeJsonSnippet((call as Record<string, unknown>)?.args ?? (call as Record<string, unknown>)?.arguments ?? {}, policy.maxFoldedToolChars);
    return args ? `${name}(${args})` : `${name}()`;
  });
}

function getMessageTurn(message: any, fallbackIndex: number): number {
  return Number.isFinite(message?.turn) ? Number(message.turn) : fallbackIndex;
}

function getRetainedTurnSet(rawMessages: any[], policy: TrimExportPolicy): Set<number> | null {
  if (!policy.keepRecentTurns) return null;
  const turns = rawMessages
    .filter(message => Number.isFinite(message?.turn))
    .map(message => Number(message.turn));
  if (turns.length === 0) return null;
  const uniqueTurns = [...new Set(turns)].sort((a, b) => a - b);
  const keptTurns = uniqueTurns.slice(-policy.keepRecentTurns);
  return new Set(keptTurns);
}

function getFoldedToolTurnSet(rawMessages: any[], retainedTurns: Set<number> | null, policy: TrimExportPolicy): Set<number> | null {
  if (policy.toolFoldScope === 'all') return null;
  if (policy.toolFoldRecentTurns) {
    const turns = rawMessages
      .map((message, index) => getMessageTurn(message, index))
      .filter(Number.isFinite);
    if (turns.length === 0) return null;
    const uniqueTurns = [...new Set(turns)].sort((a, b) => a - b);
    return new Set(uniqueTurns.slice(-policy.toolFoldRecentTurns));
  }
  return retainedTurns;
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((value, index) => jsonValueEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonValueEqual(leftRecord[key], rightRecord[key]));
}

function shouldKeepDialogueMessage(message: any, policy: TrimExportPolicy): boolean {
  const role = cleanInlineText(message?.role);
  if (role === 'user') return policy.includeUserMessages;
  if (role === 'assistant') return policy.includeAssistantMessages;
  if (role === 'system') {
    const tag = message?.tag;
    const legacyTag = typeof tag === 'string'
      ? tag
      : tag && typeof tag === 'object' && typeof (tag as any).kind === 'string'
        ? (tag as any).kind
        : undefined;
    const keepByLegacyTag = !!legacyTag
      && Array.isArray(policy.keepSystemTags)
      && policy.keepSystemTags.includes(legacyTag);
    const rules = Array.isArray((policy as any).messageRules) ? (policy as any).messageRules : [];
    const keepByRule = rules.some((rule: any) => {
      if (!rule || rule.action !== 'keep') return false;
      if (rule.role && rule.role !== role) return false;
      if (rule.source !== undefined && rule.source !== message?.source) return false;
      if (rule.tag !== undefined && !jsonValueEqual(rule.tag, tag)) return false;
      return rule.role !== undefined || rule.source !== undefined || rule.tag !== undefined;
    });
    return keepByLegacyTag || keepByRule || policy.includeSystemMessages;
  }
  return false;
}

function shouldHandleToolActivity(messageTurn: number, foldedToolTurns: Set<number> | null, policy: TrimExportPolicy): boolean {
  if (policy.toolFoldScope === 'all') return true;
  if (!foldedToolTurns) return false;
  return foldedToolTurns.has(messageTurn);
}

function getSkillInvokeProtectedMessages(rawMessages: any[], policy: TrimExportPolicy): Set<number> | null {
  if (!policy.keepRecentSkillInvokes) return null;

  // Phase 1: find the N most recent turns that contain invoke_skill calls.
  const skillTurns: number[] = [];
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const m = rawMessages[i];
    if (m?.role !== 'assistant') continue;
    const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const hasSkill = toolCalls.some((tc: any) => tc?.name === 'invoke_skill');
    if (!hasSkill) continue;
    const turn = getMessageTurn(m, i);
    if (!skillTurns.includes(turn)) {
      skillTurns.unshift(turn);
      if (skillTurns.length >= (policy.keepRecentSkillInvokes as number) && policy.keepRecentSkillInvokes !== Infinity) break;
    }
  }
  if (skillTurns.length === 0) return null;
  const protectedTurnSet = new Set(skillTurns);

  // Phase 2: collect only the specific messages to protect —
  // the assistant messages that actually carry invoke_skill calls,
  // and the tool-result messages whose toolCallId matches those calls.
  const protectedIndices = new Set<number>();
  const skillToolCallIds = new Set<string>();

  rawMessages.forEach((message, index) => {
    const turn = getMessageTurn(message, index);
    if (!protectedTurnSet.has(turn)) return;
    if (message?.role !== 'assistant') return;
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const skillCalls = toolCalls.filter((tc: any) => tc?.name === 'invoke_skill');
    if (skillCalls.length === 0) return;
    protectedIndices.add(index);
    for (const tc of skillCalls) {
      const id = cleanInlineText(tc?.id);
      if (id) skillToolCallIds.add(id);
    }
  });

  // Protect tool results for those skill calls (may be in a different turn
  // in edge cases, so match by toolCallId rather than turn).
  rawMessages.forEach((message, index) => {
    if (message?.role !== 'tool') return;
    const toolCallId = cleanInlineText(message?.toolCallId);
    if (toolCallId && skillToolCallIds.has(toolCallId)) {
      protectedIndices.add(index);
    }
  });

  return protectedIndices.size > 0 ? protectedIndices : null;
}

function createSeedMessage(role: string, content: string, turn: number, source?: string, tag?: JsonValue, timestamp?: number): SessionSeedMessage | null {
  const text = cleanMultilineText(content);
  if (!text) return null;
  return {
    role,
    content: text,
    turn: Number.isFinite(turn) ? turn : null,
    ...(source ? { source } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(typeof timestamp === 'number' && Number.isFinite(timestamp) ? { timestamp } : {}),
  } as SessionSeedMessage;
}

function deduplicateToolCallSummaries(summaries: string[]): string[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const s of summaries) {
    if (counts.has(s)) {
      counts.set(s, counts.get(s)! + 1);
    } else {
      counts.set(s, 1);
      order.push(s);
    }
  }
  return order.map(s => {
    const c = counts.get(s)!;
    return c > 1 ? `${s} ×${c}` : s;
  });
}

function flushPendingToolFold(seedMessages: SessionSeedMessage[], pendingFold: any, policy: TrimExportPolicy, stats: any): null {
  if (!pendingFold || pendingFold.toolCalls.length === 0) {
    return null;
  }

  const deduped = deduplicateToolCallSummaries(pendingFold.toolCalls);
  const lines = ['[Folded tool activity]'];
  lines.push(`assistant tool calls: ${deduped.join('; ')}`);

  const note = createSeedMessage(policy.foldedToolNoteRole, lines.join('\n'), pendingFold.turn, 'handoff-seed', 'folded-tool-activity');
  if (note) {
    seedMessages.push(note);
    stats.foldedToolNoteCount += 1;
  }
  return null;
}

export interface TrimStats {
  originalMessageCount: number;
  keptSeedMessageCount: number;
  droppedMessageCount: number;
  keptDialogueMessageCount: number;
  droppedDialogueMessageCount: number;
  foldedToolCallCount: number;
  droppedToolCallCount: number;
  foldedToolMessageCount: number;
  droppedToolMessageCount: number;
  foldedToolNoteCount: number;
  keptProtectedToolCallCount: number;
  keptProtectedToolMessageCount: number;
  retainedTurnCount: number | null;
  foldedToolTurnCount: number | null;
}

export interface TrimmedSeedResult {
  seedMessages: SessionSeedMessage[];
  stats: TrimStats;
}

export function buildTrimmedSeedMessages(rawMessages: any[], policy: TrimExportPolicy, timestamps?: (number | null)[]): TrimmedSeedResult {
  // 源消息时间投影（毫秒）：与 rawMessages 等长对齐；缺省/非法条目按无时间锚
  // 处理（seed 产物不带 timestamp 字段，消费方回退注入时刻）。
  const msgTimestamp = (index: number): number | undefined => {
    const ts = Array.isArray(timestamps) ? timestamps[index] : undefined;
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined;
  };
  const retainedTurns = getRetainedTurnSet(rawMessages, policy);
  const foldedToolTurns = getFoldedToolTurnSet(rawMessages, retainedTurns, policy);
  const skillProtectedIndices = getSkillInvokeProtectedMessages(rawMessages, policy);
  const protectedToolNames = new Set(Array.isArray(policy?.preserveToolNames) ? policy.preserveToolNames : []);
  const protectedToolCallIds = new Set<string>();
  for (const message of rawMessages) {
    const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
    for (const call of toolCalls) {
      const name = cleanInlineText(call?.name);
      const id = cleanInlineText(call?.id);
      if (name && id && protectedToolNames.has(name)) {
        protectedToolCallIds.add(id);
      }
    }
  }
  if (skillProtectedIndices) {
    rawMessages.forEach((message, index) => {
      if (!skillProtectedIndices.has(index) || message?.role !== 'assistant') return;
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      for (const call of toolCalls) {
        const id = cleanInlineText(call?.id);
        if (id && cleanInlineText(call?.name) === 'invoke_skill') {
          protectedToolCallIds.add(id);
        }
      }
    });
  }
  // keepRecentToolCalls：自链尾倒数 N 次工具调用（按调用计数，不按轮），
  // 与按名保护 / 技能保护取并集；配对结果的重放由 protectedCalls 分支与
  // tool 结果匹配分支统一承接（混合批次只重放被保护的调用，其余照常折叠）。
  if (policy.keepRecentToolCalls) {
    let budget: number = policy.keepRecentToolCalls === Infinity
      ? Number.POSITIVE_INFINITY
      : Number(policy.keepRecentToolCalls);
    for (let i = rawMessages.length - 1; i >= 0 && budget > 0; i--) {
      const message = rawMessages[i];
      if (message?.role !== 'assistant') continue;
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      for (let j = toolCalls.length - 1; j >= 0 && budget > 0; j--) {
        const id = cleanInlineText(toolCalls[j]?.id);
        if (id) {
          protectedToolCallIds.add(id);
          budget -= 1;
        }
      }
    }
  }
  const fullPreserveFrom = policy.fullPreserveFromTurn;
  const preservedTurnSet = Array.isArray(policy.preservedTurns) && policy.preservedTurns.length > 0
    ? new Set(policy.preservedTurns)
    : null;
  const preservedMsgIndices = Array.isArray(policy.preservedMsgRanges) && policy.preservedMsgRanges.length > 0
    ? new Set<number>()
    : null;
  if (preservedMsgIndices) {
    for (const [start, end] of policy.preservedMsgRanges!) {
      for (let i = start; i <= end; i++) {
        preservedMsgIndices.add(i);
      }
    }
  }
  const hasPreserveBoundary = preservedMsgIndices || preservedTurnSet || Number.isFinite(fullPreserveFrom as number);
  const seedMessages: SessionSeedMessage[] = [];
  const stats: Omit<TrimStats, 'retainedTurnCount' | 'foldedToolTurnCount'> = {
    originalMessageCount: rawMessages.length,
    keptSeedMessageCount: 0,
    droppedMessageCount: 0,
    keptDialogueMessageCount: 0,
    droppedDialogueMessageCount: 0,
    foldedToolCallCount: 0,
    droppedToolCallCount: 0,
    foldedToolMessageCount: 0,
    droppedToolMessageCount: 0,
    foldedToolNoteCount: 0,
    keptProtectedToolCallCount: 0,
    keptProtectedToolMessageCount: 0,
  };

  let pendingFold: any = null;

  const ensurePendingFold = (turn: number): any => {
    if (!pendingFold) {
      pendingFold = {
        turn,
        toolCalls: [],
        toolResults: [],
      };
    }
    return pendingFold;
  };

  const flushIfNeeded = (): void => {
    pendingFold = flushPendingToolFold(seedMessages, pendingFold, policy, stats);
  };

  const flushImmediatelyIfConfigured = (): void => {
    if (policy.foldConsecutiveToolActivity === false) {
      flushIfNeeded();
    }
  };

  rawMessages.forEach((message, index) => {
    const role = cleanInlineText(message?.role);
    if (!role) {
      stats.droppedMessageCount += 1;
      return;
    }

    const turn = getMessageTurn(message, index);
    const withinDialogueWindow = hasPreserveBoundary || !retainedTurns || retainedTurns.has(turn);

    const inPreserveZone = preservedMsgIndices
      ? preservedMsgIndices.has(index)
      : preservedTurnSet
        ? preservedTurnSet.has(turn)
        : (Number.isFinite(fullPreserveFrom as number) && turn >= (fullPreserveFrom as number));
    if (inPreserveZone) {
      flushIfNeeded();
      if (role === 'tool' || shouldKeepDialogueMessage(message, policy)) {
        const ts = msgTimestamp(index);
        seedMessages.push({ ...message, turn, ...(ts !== undefined ? { timestamp: ts } : {}) } as SessionSeedMessage);
        stats.keptSeedMessageCount += 1;
        if (role !== 'tool') {
          stats.keptDialogueMessageCount += 1;
        }
      } else {
        stats.droppedDialogueMessageCount += 1;
        stats.droppedMessageCount += 1;
      }
      return;
    }

    let toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
    const protectedCalls = role === 'assistant'
      ? toolCalls.filter((call: any) => protectedToolCallIds.has(cleanInlineText(call?.id)))
      : [];
    if (protectedCalls.length > 0 && shouldKeepDialogueMessage(message, policy)) {
      flushIfNeeded();
      const tsProtected = msgTimestamp(index);
      seedMessages.push({ ...message, toolCalls: protectedCalls, turn, ...(tsProtected !== undefined ? { timestamp: tsProtected } : {}) } as SessionSeedMessage);
      stats.keptSeedMessageCount += 1;
      stats.keptDialogueMessageCount += 1;
      stats.keptProtectedToolCallCount += protectedCalls.length;

      toolCalls = toolCalls.filter((call: any) => !protectedToolCallIds.has(cleanInlineText(call?.id)));
      if (toolCalls.length === 0) {
        return;
      }
      message = { ...message, content: '', toolCalls };
    }

    if (role === 'tool' && protectedToolCallIds.has(cleanInlineText(message?.toolCallId))) {
      const tsTool = msgTimestamp(index);
      seedMessages.push({ ...message, turn, ...(tsTool !== undefined ? { timestamp: tsTool } : {}) } as SessionSeedMessage);
      stats.keptSeedMessageCount += 1;
      stats.keptProtectedToolMessageCount += 1;
      return;
    }

    if (role === 'tool') {
      if (!withinDialogueWindow) {
        stats.droppedToolMessageCount += 1;
        stats.droppedMessageCount += 1;
        return;
      }

      const shouldHandle = hasPreserveBoundary
        ? true
        : shouldHandleToolActivity(turn, foldedToolTurns, policy);
      if (policy.toolMessageMode === 'keep' || !shouldHandle) {
        flushIfNeeded();
        const seedMessage = createSeedMessage('tool', message.content, turn, message?.source, message?.tag, msgTimestamp(index));
        if (seedMessage) {
          seedMessages.push(seedMessage);
          stats.keptSeedMessageCount += 1;
        } else {
          stats.droppedMessageCount += 1;
        }
        return;
      }

      if (policy.toolMessageMode === 'drop') {
        stats.droppedToolMessageCount += 1;
        stats.droppedMessageCount += 1;
        return;
      }

      ensurePendingFold(turn);
      stats.foldedToolMessageCount += 1;
      stats.droppedMessageCount += 1;
      flushImmediatelyIfConfigured();
      return;
    }

    const shouldHandleToolCalls = toolCalls.length > 0 && (hasPreserveBoundary
      ? true
      : shouldHandleToolActivity(turn, foldedToolTurns, policy));
    const toolCallSummaries = summarizeAssistantToolCalls(toolCalls, policy);

    if (!withinDialogueWindow) {
      if (role === 'assistant' || role === 'user' || role === 'system') {
        stats.droppedDialogueMessageCount += 1;
      }
      if (shouldHandleToolCalls) {
        if (policy.assistantToolCallMode === 'fold') {
          stats.foldedToolCallCount += toolCalls.length;
        } else if (policy.assistantToolCallMode === 'drop') {
          stats.droppedToolCallCount += toolCalls.length;
        }
      }
      stats.droppedMessageCount += 1;
      return;
    }

    const isToolOnlyAssistantFold = role === 'assistant'
      && !cleanMultilineText(message.content)
      && toolCalls.length > 0
      && policy.assistantToolCallMode === 'fold'
      && shouldHandleToolCalls;
    if (!isToolOnlyAssistantFold) {
      flushIfNeeded();
    }

    if (!shouldKeepDialogueMessage(message, policy)) {
      stats.droppedDialogueMessageCount += 1;
      stats.droppedMessageCount += 1;
    } else {
      let assistantContent = cleanMultilineText(message.content);
      if (role === 'assistant' && toolCalls.length > 0 && policy.assistantToolCallMode === 'keep' && toolCallSummaries.length > 0 && shouldHandleToolCalls) {
        assistantContent = `${assistantContent}\n[tool calls kept inline] ${toolCallSummaries.join('; ')}`.trim();
      }
      const seedMessage = createSeedMessage(role, assistantContent, turn, message?.source, message?.tag, msgTimestamp(index));
      if (seedMessage) {
        seedMessages.push(seedMessage);
        stats.keptSeedMessageCount += 1;
        if (role === 'assistant' || role === 'user' || role === 'system') {
          stats.keptDialogueMessageCount += 1;
        }
      } else if (role !== 'assistant' || toolCalls.length === 0) {
        stats.droppedMessageCount += 1;
      }
    }

    if (role === 'assistant' && toolCalls.length > 0 && shouldHandleToolCalls) {
      if (policy.assistantToolCallMode === 'fold') {
        const fold = ensurePendingFold(turn);
        fold.toolCalls.push(...toolCallSummaries);
        stats.foldedToolCallCount += toolCalls.length;
        flushImmediatelyIfConfigured();
      } else if (policy.assistantToolCallMode === 'drop') {
        stats.droppedToolCallCount += toolCalls.length;
      }
    }
  });

  flushPendingToolFold(seedMessages, pendingFold, policy, stats);
  return {
    seedMessages,
    stats: {
      ...stats,
      retainedTurnCount: retainedTurns ? retainedTurns.size : null,
      foldedToolTurnCount: foldedToolTurns ? foldedToolTurns.size : null,
    },
  };
}

// ============ Transformation 契约实现 ============

export interface TrimTranscriptTransformationOptions {
  /**
   * 默认策略（可被 `transform` 传入的 policy 按需覆盖）。缺省为空对象，
   * 即 `normalizeExportPolicy({})` 的默认裁剪行为。
   */
  defaultPolicy?: Record<string, unknown>;
}

/**
 * Trim-Transcript 变换：对源会话快照施加裁剪变换，产出 SuccessorSeed。
 *
 * 从 `sourceSnapshot.runtime.context.messages` 读取消息（session-store 契约级
 * 消费面），以 `policy` 为裁剪策略面（归一化语义见 normalizeExportPolicy）。
 */
export class TrimTranscriptTransformation implements SessionTransformation {
  readonly id = 'agentdev.trim-transcript';

  private readonly defaultPolicy: Record<string, unknown>;

  constructor(options: TrimTranscriptTransformationOptions = {}) {
    this.defaultPolicy = options.defaultPolicy ?? {};
  }

  async transform(input: TransformInput, _ctx: TransformContext): Promise<SuccessorSeed> {
    const snapshot: AgentSessionSnapshot = input.sourceSnapshot;
    const rawMessages = Array.isArray(snapshot?.runtime?.context?.messages)
      ? snapshot.runtime.context.messages
      : [];
    // 时间投影：与 messages 平行对齐的 enriched 侧 timestamp 表；长度失配
    // （结构异常的旧快照）按无时间锚降级，不阻断变换。
    const enriched = snapshot?.runtime?.context?.enrichedMessages;
    const timestamps = Array.isArray(enriched) && enriched.length === rawMessages.length
      ? enriched.map((e: any) => (typeof e?.timestamp === 'number' && Number.isFinite(e.timestamp) ? e.timestamp : null))
      : undefined;

    const policy = normalizeExportPolicy({ ...this.defaultPolicy, ...(input.policy ?? {}) });
    const { seedMessages, stats } = buildTrimmedSeedMessages(rawMessages, policy, timestamps);
    // seed 边界账目（ADR-0024 PR-3）：全部产物为保留素材 + 折叠注（折叠注的
    // 投影由 stats / keepSystemTags 规则覆盖），变换自身不追加注入项。
    const seedBoundary: SeedBoundary = {
      seedMessageCount: seedMessages.length,
      appendedInjection: [],
    };

    return {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      seedMessages,
      seedBoundary,
      meta: {
        compilerVersion: HANDOFF_COMPILER_VERSION,
        seedKind: 'message-replay',
        mode: policy.strategy,
        policy,
        stats,
      },
    };
  }
}

// 兼容导出（与 Claw 策略引擎同名，便于 golden 对照直读）
export { sanitizeFragment, cleanInlineText, cleanMultilineText };
