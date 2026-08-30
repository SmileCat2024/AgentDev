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
import type {
  SessionTransformation,
  TransformInput,
  TransformContext,
  SuccessorSeed,
  SessionSeedMessage,
} from '../index.js';

// ============ 常量与默认策略 ============

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_COMPILER_VERSION = 'trim-transcript-v1';

export const DEFAULT_EXPORT_POLICY = {
  strategy: 'trim-transcript',
  includeSystemMessages: false,
  keepSystemTags: ['folded-tool-activity'],
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

function normalizeKeepRecentSkillInvokes(value: unknown): number | null | typeof Infinity {
  if (value === null || value === undefined || value === '' || value === false) return null;
  if (value === Infinity || value === 'Infinity') return Infinity;
  return clampInteger(value as number, 1, 1, 2000);
}

function normalizeToolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanInlineText).filter(Boolean))];
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
  preserveToolNames: string[];
}

export function normalizeExportPolicy(rawPolicy: Record<string, unknown> = {}): TrimExportPolicy {
  return {
    strategy: 'trim-transcript',
    includeSystemMessages: rawPolicy?.includeSystemMessages === true,
    keepSystemTags: normalizeKeepSystemTags(rawPolicy?.keepSystemTags),
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
    keepRecentSkillInvokes: normalizeKeepRecentSkillInvokes(rawPolicy?.keepRecentSkillInvokes),
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

function shouldKeepDialogueMessage(role: string, policy: TrimExportPolicy, tag?: string): boolean {
  if (role === 'user') return policy.includeUserMessages;
  if (role === 'assistant') return policy.includeAssistantMessages;
  if (role === 'system') {
    if (tag && Array.isArray(policy.keepSystemTags) && policy.keepSystemTags.includes(tag)) return true;
    return policy.includeSystemMessages;
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

function createSeedMessage(role: string, content: string, turn: number, tag?: string): SessionSeedMessage | null {
  const text = cleanMultilineText(content);
  if (!text) return null;
  return {
    role,
    content: text,
    turn: Number.isFinite(turn) ? turn : null,
    ...(tag ? { tag } : {}),
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

  const note = createSeedMessage(policy.foldedToolNoteRole, lines.join('\n'), pendingFold.turn, 'folded-tool-activity');
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

export function buildTrimmedSeedMessages(rawMessages: any[], policy: TrimExportPolicy): TrimmedSeedResult {
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
      const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
      for (const call of toolCalls) {
        const id = cleanInlineText(call?.id);
        if (id && cleanInlineText(call?.name) === 'invoke_skill') {
          protectedToolCallIds.add(id);
        }
      }
    });
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
      if (role === 'tool' || shouldKeepDialogueMessage(role, policy, message?.tag)) {
        seedMessages.push({ ...message, turn } as SessionSeedMessage);
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
    if (protectedCalls.length > 0 && shouldKeepDialogueMessage(role, policy, message?.tag)) {
      flushIfNeeded();
      seedMessages.push({ ...message, toolCalls: protectedCalls, turn } as SessionSeedMessage);
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
      seedMessages.push({ ...message, turn } as SessionSeedMessage);
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
        const seedMessage = createSeedMessage('tool', message.content, turn, message?.tag);
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

    if (!shouldKeepDialogueMessage(role, policy, message?.tag)) {
      stats.droppedDialogueMessageCount += 1;
      stats.droppedMessageCount += 1;
    } else {
      let assistantContent = cleanMultilineText(message.content);
      if (role === 'assistant' && toolCalls.length > 0 && policy.assistantToolCallMode === 'keep' && toolCallSummaries.length > 0 && shouldHandleToolCalls) {
        assistantContent = `${assistantContent}\n[tool calls kept inline] ${toolCallSummaries.join('; ')}`.trim();
      }
      const seedMessage = createSeedMessage(role, assistantContent, turn, message?.tag);
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

    const policy = normalizeExportPolicy({ ...this.defaultPolicy, ...(input.policy ?? {}) });
    const { seedMessages, stats } = buildTrimmedSeedMessages(rawMessages, policy);

    return {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      seedMessages,
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
