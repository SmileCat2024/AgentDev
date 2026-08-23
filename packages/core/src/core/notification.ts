/**
 * Notification System - 核心通知系统
 *
 * 职责：
 * - 定义通知类型和分类
 * - 提供通知发送接口
 * - 管理通知上下文（当前 Agent ID）
 * - 节流高频通知
 *
 * 上下文隔离机制：
 * 使用 AsyncLocalStorage 实现 per-call 上下文隔离，
 * 确保同进程内多个并发的 Agent.onCall() 调用各自的通知路由正确。
 * 旧的全局 set/clear API 作为向后兼容 fallback 保留。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Notification, NotificationCategory, LLMPhase } from './types.js';
import type { CallOutcome } from './lifecycle.js';
import { DebugHub } from './debug-hub.js';

// ========== AsyncLocalStorage 上下文 ==========

interface NotificationScope {
  agentId: string;
  lastNotificationTime: number;
  lastLLMPhase: string | null;
}

const notificationAls = new AsyncLocalStorage<NotificationScope>();

/**
 * 在通知作用域中执行函数。
 *
 * 使用 AsyncLocalStorage 实现 per-call 上下文隔离，
 * 确保同进程内多个并发的 Agent.onCall() 调用各自的通知路由正确。
 * 在此作用域内调用的 emitNotification 会自动使用作用域的 agentId。
 *
 * @param agentId 当前调用的 Agent ID
 * @param fn 在作用域内执行的函数
 * @returns fn 的返回值
 */
export function runWithNotificationScope<T>(agentId: string, fn: () => T): T {
  return notificationAls.run(
    { agentId, lastNotificationTime: 0, lastLLMPhase: null },
    fn,
  );
}

// ========== 模块级 fallback（向后兼容） ==========

let _fallbackAgentId: string | null = null;
let _fallbackLastTime: number = 0;
let _fallbackLastPhase: string | null = null;

/**
 * 持久化的 fallback scope 对象，字段代理到模块级变量。
 * 仅在无 ALS scope 时使用。
 */
const _fallbackScope: NotificationScope = {
  get agentId() { return _fallbackAgentId!; },
  get lastNotificationTime() { return _fallbackLastTime; },
  set lastNotificationTime(v: number) { _fallbackLastTime = v; },
  get lastLLMPhase() { return _fallbackLastPhase; },
  set lastLLMPhase(v: string | null) { _fallbackLastPhase = v; },
};

/**
 * 获取当前活跃的通知上下文。
 * 优先返回 ALS scope，回退到模块级 fallback。
 */
function getActiveScope(): NotificationScope | null {
  const als = notificationAls.getStore();
  if (als) return als;
  if (_fallbackAgentId) return _fallbackScope;
  return null;
}

// ========== 节流 ==========

const THROTTLE_INTERVAL = 100;

// ========== 公开 API ==========

/**
 * 设置通知上下文（向后兼容）
 *
 * @deprecated 使用 runWithNotificationScope 替代。
 * 此函数仅设置模块级 fallback，不影响 ALS scope。
 *
 * @param agentId Agent ID
 */
export function _setNotificationAgent(agentId: string): void {
  _fallbackAgentId = agentId;
}

/**
 * 清除通知上下文（向后兼容）
 *
 * @deprecated 使用 runWithNotificationScope 替代。
 * 此函数仅清除模块级 fallback。
 */
export function _clearNotificationAgent(): void {
  _fallbackAgentId = null;
  _fallbackLastTime = 0;
  _fallbackLastPhase = null;
}

/**
 * 获取当前通知上下文的 Agent ID。
 * 优先返回 ALS scope 的 agentId，回退到模块级 fallback。
 */
export function _getCurrentNotificationAgent(): string | null {
  return notificationAls.getStore()?.agentId ?? _fallbackAgentId;
}

/**
 * 发送通知到 DebugHub
 * @param notification 通知对象
 */
export function emitNotification(notification: Notification): void {
  const scope = getActiveScope();
  if (!scope) {
    // 没有通知上下文，静默忽略
    return;
  }

  const now = Date.now();
  const notificationType = String(notification.type || '');
  const bypassThrottle = notificationType === 'call.start'
    || notificationType === 'call.finish'
    || notificationType === 'llm.complete';

  // 阶段转换检测：llm.char_count 的 phase 变化时绕过节流，
  // 确保用户立即看到 thinking→content→tool_calling 的阶段切换
  let phaseTransition = false;
  if (notificationType === 'llm.char_count') {
    const data = notification.data as Record<string, unknown> | undefined;
    const phase = typeof data?.phase === 'string' ? data.phase : '';
    if (phase && phase !== scope.lastLLMPhase) {
      phaseTransition = true;
      scope.lastLLMPhase = phase;
    }
  }

  // 节流：状态类通知需要节流，事件类通知不需要
  // 阶段转换也绕过节流
  if (notification.category === 'state' && !bypassThrottle && !phaseTransition) {
    const timeSinceLast = now - scope.lastNotificationTime;
    if (timeSinceLast < THROTTLE_INTERVAL) {
      // 跳过此次通知
      return;
    }
    scope.lastNotificationTime = now;
  } else if (phaseTransition) {
    // 阶段转换绕过节流，但仍需更新 lastNotificationTime
    // 否则紧随其后的同 phase 通知也会因为 timeSinceLast 过大而绕过
    scope.lastNotificationTime = now;
  }

  // 推送到 DebugHub
  const debugHub = DebugHub.getInstance();
  debugHub.pushNotification(scope.agentId, notification);
}

// ========== 通知构造函数 ==========

/**
 * 创建 LLM 字符计数通知
 * @param charCount 当前累积字符数
 * @param phase LLM 生成阶段
 */
export function createLLMCharCount(
  charCount: number,
  phase: LLMPhase,
  extras?: {
    thinkingChars?: number;
    contentChars?: number;
    toolCallCount?: number;
    streamToolNames?: string[];
  },
): Notification {
  return {
    type: 'llm.char_count',
    category: 'state',
    timestamp: Date.now(),
    data: {
      charCount,
      phase,
      ...(typeof extras?.thinkingChars === 'number' ? { thinkingChars: extras.thinkingChars } : {}),
      ...(typeof extras?.contentChars === 'number' ? { contentChars: extras.contentChars } : {}),
      ...(typeof extras?.toolCallCount === 'number' ? { toolCallCount: extras.toolCallCount } : {}),
      ...(Array.isArray(extras?.streamToolNames) && extras.streamToolNames.length > 0
        ? { streamToolNames: extras.streamToolNames }
        : {}),
    },
  };
}

/**
 * 创建 LLM 完成通知
 * @param totalChars 总字符数
 */
export function createLLMComplete(totalChars: number): Notification {
  return {
    type: 'llm.complete',
    category: 'state',
    timestamp: Date.now(),
    data: {
      totalChars,
    },
  };
}

/** llm.retry 通知 data：单次模型请求内部的重试过程观测。 */
export interface LLMRetryData {
  /** waiting：进入退避等待；requesting：等待结束、即将重发请求 */
  phase: 'waiting' | 'requesting';
  /** 即将进行的第几次重试（1-based） */
  attempt: number;
  /** 适配器配置的最大重试次数 */
  maxRetries: number;
  /** 本次退避等待时长（ms），仅 waiting 阶段有值 */
  delayMs?: number;
  /** 分类后的错误类型（APIErrorType） */
  errorType?: string;
  /** HTTP 状态码（如有） */
  statusCode?: number;
}

/**
 * 创建 LLM 重试通知（事件类）
 *
 * 适配器在自动重试的等待前 / 重发前发射。这是纯观测信号，
 * 不改变 Call 的执行控制流。
 */
export function createLLMRetry(data: LLMRetryData): Notification {
  return {
    type: 'llm.retry',
    category: 'event',
    timestamp: Date.now(),
    data: { ...data },
  };
}

/**
 * 创建工具开始通知
 * @param toolName 工具名称
 */
export function createToolStart(toolName: string): Notification {
  return {
    type: 'tool.start',
    category: 'event',
    timestamp: Date.now(),
    data: {
      toolName,
    },
  };
}

/**
 * 创建工具完成通知
 * @param toolName 工具名称
 * @param success 是否成功
 * @param duration 耗时（毫秒）
 */
export function createToolComplete(
  toolName: string,
  success: boolean,
  duration: number
): Notification {
  return {
    type: 'tool.complete',
    category: 'event',
    timestamp: Date.now(),
    data: {
      toolName,
      success,
      duration,
    },
  };
}

/** tool.progress 通知 data：工具执行中的进度信号（ticket 023，schema 定义）。 */
export interface ToolProgressData {
  /** LLM 生成的 call.id（与 tool_call 条目配对） */
  callId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具开始执行的 Unix 毫秒时间戳 */
  startedAt: number;
  /** 已执行时长（毫秒），由发射方计算 */
  elapsedMs: number;
  /** 本调用的生效超时（毫秒）；工具未声明 timeout 时为 null */
  timeoutMs: number | null;
  /** 输出尾部文本；由发射方截尾，本票只定 schema */
  outputTail?: string;
}

/**
 * 创建工具进度通知（state 类，自动获得通知系统节流）
 *
 * 执行中可见性通道（ADR-0005）：长任务工具可周期性发射，前端据此渲染
 * "已运行 Ns / 超时 Xm / 尾部输出" 卡片。不进 session-events 审计流——
 * 审计关心终态（interrupted 字段已覆盖），不节流的事件流加尾部输出会让
 * 无头 jsonl 爆炸。发射方负责 outputTail 截尾。
 */
export function createToolProgress(data: ToolProgressData): Notification {
  return {
    type: 'tool.progress',
    category: 'state',
    timestamp: Date.now(),
    data: { ...data },
  };
}

/**
 * 创建 Call 开始通知
 */
export function createCallStart(): Notification {
  return {
    type: 'call.start',
    category: 'state',
    timestamp: Date.now(),
    data: {},
  };
}

/**
 * 创建 Call 结束通知
 *
 * data 携带完整结构化终态（CallOutcome），消费端（ViewerWorker / 前端 /
 * 审计）依据 status/reason/error 判断结果，不再解析文本。
 */
export function createCallFinish(outcome: CallOutcome): Notification {
  return {
    type: 'call.finish',
    category: 'state',
    timestamp: Date.now(),
    data: { ...outcome },
  };
}

/** call.finish 通知 data 的形状（即 CallOutcome）。 */
export type CallFinishData = CallOutcome;
