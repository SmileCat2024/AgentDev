/**
 * Notification System - 核心通知系统
 *
 * 职责：
 * - 定义通知类型和分类
 * - 提供通知发送接口
 * - 管理通知上下文（当前 Agent ID）
 * - 节流高频通知
 */

import type { Notification, NotificationCategory, LLMPhase } from './types.js';
import { DebugHub } from './debug-hub.js';

// ========== 模块级状态 ==========

/**
 * 当前通知上下文的 Agent ID
 */
let currentAgentId: string | null = null;

/**
 * 节流控制：上次发送通知的时间戳
 */
let lastNotificationTime: number = 0;

/**
 * 节流间隔（毫秒）
 */
const THROTTLE_INTERVAL = 100;

/**
 * 上次通知的 LLM 阶段，用于检测阶段转换
 */
let lastLLMPhase: string | null = null;

// ========== 公开 API ==========

/**
 * 设置通知上下文
 * @param agentId Agent ID
 */
export function _setNotificationAgent(agentId: string): void {
  currentAgentId = agentId;
}

/**
 * 清除通知上下文
 */
export function _clearNotificationAgent(): void {
  currentAgentId = null;
  // 重置节流状态
  lastNotificationTime = 0;
  lastLLMPhase = null;
}

/**
 * 获取当前通知上下文的 Agent ID
 */
export function _getCurrentNotificationAgent(): string | null {
  return currentAgentId;
}

/**
 * 发送通知到 DebugHub
 * @param notification 通知对象
 */
export function emitNotification(notification: Notification): void {
  if (!currentAgentId) {
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
    if (phase && phase !== lastLLMPhase) {
      phaseTransition = true;
      lastLLMPhase = phase;
    }
  }

  // 节流：状态类通知需要节流，事件类通知不需要
  // 阶段转换也绕过节流
  if (notification.category === 'state' && !bypassThrottle && !phaseTransition) {
    const timeSinceLast = now - lastNotificationTime;
    if (timeSinceLast < THROTTLE_INTERVAL) {
      // 跳过此次通知
      return;
    }
    lastNotificationTime = now;
  } else if (phaseTransition) {
    // 阶段转换绕过节流，但仍需更新 lastNotificationTime
    // 否则紧随其后的同 phase 通知也会因为 timeSinceLast 过大而绕过
    lastNotificationTime = now;
  }

  // 推送到 DebugHub
  const debugHub = DebugHub.getInstance();
  debugHub.pushNotification(currentAgentId, notification);
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
 * @param completed 是否正常完成（false 表示被中断或出错）
 */
export function createCallFinish(completed: boolean, finishReason?: string): Notification {
  return {
    type: 'call.finish',
    category: 'state',
    timestamp: Date.now(),
    data: { completed, ...(finishReason ? { finishReason } : {}) },
  };
}
