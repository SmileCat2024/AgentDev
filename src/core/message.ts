/**
 * 消息创建工具
 * 简单的工厂函数，直观易懂
 */

import type { Message, MessageRole, ToolCall } from './types.js';

/**
 * 创建消息
 */
export function createMessage(role: MessageRole, content: string, toolCalls?: ToolCall[], reasoning?: string): Message {
  return { role, content, toolCalls, reasoning };
}

/**
 * 创建系统消息
 */
export function system(content: string): Message {
  return createMessage('system', content);
}

/**
 * 创建用户消息
 */
export function user(content: string): Message {
  return createMessage('user', content);
}

/**
 * 创建助手消息
 */
export function assistant(content: string, toolCalls?: ToolCall[], reasoning?: string): Message {
  return createMessage('assistant', content, toolCalls, reasoning);
}

/**
 * 创建工具返回消息
 */
export function toolResult(toolCallId: string, content: string): Message {
  return { role: 'tool', content, toolCallId };
}

/**
 * 克隆消息数组
 */
export function cloneMessages(messages: Message[]): Message[] {
  return messages.map(m => ({ ...m }));
}
