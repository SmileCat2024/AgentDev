/**
 * Agent 内部类型定义
 *
 * 定义 ReAct 循环和工具执行所需的内部类型
 */

import type { Context } from '../context.js';
import type { ToolCall } from '../types.js';
import type { ContextInjector } from '../feature.js';
import type { Message } from '../types.js';

// 重新导出所有类型，供其他模块使用
export type { Context } from '../context.js';
export type { ToolCall } from '../types.js';

/**
 * ReAct 循环执行上下文
 */
export interface ReActContext {
  /** 用户输入 */
  input: string;
  /** 对话上下文 */
  context: Context;
  /** 是否首次调用 */
  isFirstCall: boolean;
  /** 调用 ID */
  callId: number;
  /** 调用开始时间 */
  callStartTime: number;
}

/**
 * ReAct 循环执行结果
 */
export interface ReActResult {
  /** 最终响应 */
  finalResponse: string;
  /** 是否完成 */
  completed: boolean;
  /** 执行轮次 */
  turns: number;
}

/**
 * 工具执行选项
 */
export interface ToolExecuteOptions {
  /** 上下文注入器列表 */
  contextInjectors: Array<{
    pattern: string | RegExp;
    injector: ContextInjector;
  }>;
  /** 父代理引用（用于子代理工具） */
  parentAgent: any;
}

/**
 * Agent 类型引用（用于解决循环依赖）
 */
export type AgentLike = {
  llm: any;
  tools: any;
  maxTurns: number;
  debugEnabled: boolean;
  agentId?: string;
  _pool?: any;
  _currentTurn: number;
  _agentId?: string;
  _parentPool?: any;
  debugPusher?: DebugPusher;
};

/**
 * Debug 推送接口
 * 解耦 DebugHub 依赖
 */
export interface DebugPusher {
  pushMessages(agentId: string, messages: Message[]): void;
}

/**
 * 单轮执行结果
 */
export interface TurnResult {
  /** LLM 响应内容 */
  response: string;
  /** 是否需要更多轮次 */
  shouldContinue: boolean;
  /** 工具调用列表 */
  toolCalls: ToolCall[];
}
