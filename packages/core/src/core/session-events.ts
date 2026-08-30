/**
 * Session Events - 会话事件流
 *
 * 职责：
 * - 定义无头模式（headless）消费的会话事件模型（codex exec 风格）
 * - 提供进程内订阅 API，消息变更单点发射
 *
 * 与通知系统（notification.ts）的分工：
 * - notification 是 UI 状态信号：节流、轻量、面向 Web UI 进度指示
 * - session event 是审计数据：不节流、完整、面向无头模式 stdout JSONL
 *
 * 事件模型（对齐 codex exec JSONL）：
 * - thread.started  线程（会话）开始
 * - turn.started    一次用户输入触发的回合开始
 * - item.started / item.completed  会话条目生命周期
 * - turn.completed  回合完成（含 token 用量）
 * - turn.failed     回合失败
 *
 * 术语（ADR-0002/Q6，一词不混用）：本事件流里的 `thread.started` 的 thread
 * 指**会话本身**（codex exec 对外 jsonl 审计契约，永不改义）；框架的接续链概念
 * 定名 **WorkThread**（见 `core/workthread/`），一处不混用。
 *
 * item 类型：
 * - agent_message  agent 的自然语言回复
 * - reasoning      agent 的思考摘要
 * - tool_call      工具调用（参数、结果、错误、状态）
 */

import type { LLMResponse, ToolCall } from './types.js';
import type { ToolExecResult } from './context.js';

// ========== Item 模型 ==========

export interface SessionItemBase {
  /** 条目唯一 ID：tool_call 用 LLM 生成的 call.id，其余用递增 item_N */
  id: string;
  /** 所属回合（callIndex） */
  turn: number;
}

export interface AgentMessageItem extends SessionItemBase {
  type: 'agent_message';
  text: string;
}

export interface ReasoningItem extends SessionItemBase {
  type: 'reasoning';
  text: string;
}

export type ToolCallStatus = 'in_progress' | 'completed' | 'failed';

export interface ToolCallItem extends SessionItemBase {
  type: 'tool_call';
  /** 工具名称（如 shell / read / lsp_hover） */
  tool: string;
  /** 工具调用参数 */
  arguments?: unknown;
  status: ToolCallStatus;
  /** 成功时的结果内容 */
  result?: unknown;
  /** 失败时的错误信息 */
  error?: string;
  /**
   * 终止标注（ticket 023 / ADR-0005）：工具被超时/用户打断终止但仍在 settle
   * 窗口内收尾时出现。success 结果可携带此字段，无头 jsonl 审计据此区分
   * 正常完成与被终止收尾。
   */
  interrupted?: { reason: 'timeout' | 'user' };
}

export type SessionItem = AgentMessageItem | ReasoningItem | ToolCallItem;

// ========== 事件模型 ==========

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * 回合失败的结构化事实。
 *
 * message 只供人读；reason/category/retryable 供机器分流，
 * 与 CallOutcome 对齐（无头 CLI/JSONL 消费同一套语义）。
 */
export interface TurnFailure {
  message: string;
  /** 框架级终止原因（ExecutionReason） */
  reason?: string;
  /** 分类错误类型（APIErrorType / runtime_error / exception） */
  category?: string;
  statusCode?: number;
  retryable?: boolean;
}

export type SessionEvent =
  | { type: 'thread.started'; threadId: string }
  | { type: 'turn.started'; turn: number }
  | { type: 'item.started'; item: SessionItem }
  | { type: 'item.completed'; item: SessionItem }
  | { type: 'turn.completed'; turn: number; usage?: TurnUsage }
  | { type: 'turn.failed'; turn: number; error: TurnFailure };

export type SessionEventListener = (event: SessionEvent) => void;

// ========== 订阅管理 ==========

const listeners = new Set<SessionEventListener>();

let nextItemSeq = 0;

function nextItemId(): string {
  return `item_${nextItemSeq++}`;
}

/**
 * 订阅会话事件流。
 * @returns 退订函数
 */
export function subscribeSessionEvents(listener: SessionEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 发射会话事件。无订阅者时零开销。
 */
export function emitSessionEvent(event: SessionEvent): void {
  if (listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // 订阅者异常不影响主流程
    }
  }
}

// ========== 发射辅助（context / agent 调用） ==========

/**
 * 发射 assistant 响应产生的条目事件：
 * reasoning / agent_message 以 completed 出现（一次性内容），
 * 每个 toolCall 以 started 出现（等待执行结果）。
 */
export function emitAssistantResponseEvents(response: LLMResponse, turn: number): void {
  if (listeners.size === 0) return;

  if (response.reasoning && response.reasoning.trim()) {
    emitSessionEvent({
      type: 'item.completed',
      item: { id: nextItemId(), turn, type: 'reasoning', text: response.reasoning },
    });
  }

  if (response.content && response.content.trim()) {
    emitSessionEvent({
      type: 'item.completed',
      item: { id: nextItemId(), turn, type: 'agent_message', text: response.content },
    });
  }

  if (response.toolCalls) {
    for (const call of response.toolCalls) {
      emitSessionEvent({
        type: 'item.started',
        item: {
          id: call.id ?? nextItemId(),
          turn,
          type: 'tool_call',
          tool: call.name,
          arguments: call.arguments,
          status: 'in_progress',
        },
      });
    }
  }
}

/**
 * 发射工具结果条目事件（与 emitAssistantResponseEvents 的 started 配对，靠 call.id 关联）。
 */
export function emitToolResultEvents(call: ToolCall, result: ToolExecResult, turn: number): void {
  if (listeners.size === 0) return;

  emitSessionEvent({
    type: 'item.completed',
    item: {
      id: call.id ?? nextItemId(),
      turn,
      type: 'tool_call',
      tool: call.name,
      arguments: call.arguments,
      status: result.success ? 'completed' : 'failed',
      ...(result.success
        ? { result: result.result }
        : { error: result.error ?? 'tool execution failed' }),
      ...(result.interrupted ? { interrupted: result.interrupted } : {}),
    },
  });
}

/**
 * 发射回合完成事件（附 token 用量）。
 */
export function emitTurnCompleted(turn: number, usage?: TurnUsage): void {
  emitSessionEvent({ type: 'turn.completed', turn, ...(usage ? { usage } : {}) });
}

/**
 * 发射回合失败事件。
 *
 * 支持两种入参：
 * - CallOutcome（agent.ts 主链路）：展开为结构化 TurnFailure
 * - 简单 message（宿主致命错误等）：仅带 message
 */
import type { CallOutcome } from './lifecycle.js';

export function emitTurnFailed(turn: number, source: string | CallOutcome): void {
  if (typeof source === 'string') {
    emitSessionEvent({ type: 'turn.failed', turn, error: { message: source } });
    return;
  }
  emitSessionEvent({
    type: 'turn.failed',
    turn,
    error: {
      message: source.error?.message ?? source.response ?? source.reason,
      reason: source.reason,
      ...(source.error ? {
        category: source.error.category,
        ...(typeof source.error.statusCode === 'number' ? { statusCode: source.error.statusCode } : {}),
        ...(typeof source.error.retryable === 'boolean' ? { retryable: source.error.retryable } : {}),
      } : {}),
    },
  });
}
