/**
 * 生命周期类型定义
 * 定义 Agent 生命周期钩子相关的类型
 */

import type { ToolCall, Tool } from './types.js';
import { Context } from './context.js';

/**
 * 工具上下文 - onPreToolUse 钩子的参数
 *
 * 提供工具调用时的完整上下文信息
 */
export interface ToolContext {
  /** 工具调用 */
  call: ToolCall;
  /** 工具定义 */
  tool: Tool;
  /** 当前轮次 */
  turn: number;
  /** 用户输入 */
  input: string;
  /** 消息上下文（可读写） */
  context: Context;
}

/**
 * 工具结果 - onPostToolUse 钩子的参数
 *
 * 提供工具执行后的完整结果信息
 */
export interface ToolResult {
  /** 是否成功 */
  success: boolean;
  /** 返回数据 */
  data: unknown;
  /** 错误信息（如果失败） */
  error?: string;
  /** 执行耗时(ms) */
  duration: number;
  /** 工具调用 */
  call: ToolCall;
  /** 工具定义 */
  tool: Tool;
  /** 当前轮次 */
  turn: number;
  /** 用户输入 */
  input: string;
  /** 消息上下文 */
  context: Context;
}

/**
 * 钩子返回值类型
 *
 * 用于控制工具调用的行为：
 * - undefined: 默认行为（一律放行）
 * - { action: 'block' }: 阻止工具执行，可选提供原因
 * - { action: 'allow' }: 明确允许工具执行
 */
export type HookResult =
  | { action: 'block'; reason?: string }
  | { action: 'allow' }
  | undefined;
