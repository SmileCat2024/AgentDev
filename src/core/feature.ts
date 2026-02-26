/**
 * Feature System - 可外挂功能模块接口
 *
 * Feature 系统允许将功能（MCP、Skills、子代理等）从 Agent 核心中解耦，
 * 实现新功能的声明式注册和统一的生命周期管理。
 */

import type { Tool } from './types.js';
import type { ToolCall } from './types.js';
import type { Context } from './context.js';
import type { LLMResponse } from './types.js';

/**
 * ReAct 循环钩子接口
 *
 * 允许 Feature 在 ReAct 循环的关键执行点注入自定义逻辑
 * 只有需要介入 ReAct 循环的 Feature 才需要实现此接口
 */
export interface ReActLoopHooks {
  /**
   * 工具调用完成后钩子
   *
   * 调用时机：所有工具 execute() 完成后，turnFinished 钩子之前
   * 典型用途：子代理消息消费、异步状态更新
   */
  afterToolCalls?(ctx: {
    context: Context;
    toolCalls: ToolCall[];
    turn: number;
  }): Promise<void>;

  /**
   * 无工具调用时钩子
   *
   * 调用时机：LLM 返回没有 toolCalls 的响应时
   * 典型用途：子代理自动等待、被动状态处理
   *
   * @returns 返回 { shouldEnd: false } 表示不结束循环，继续下一轮
   */
  beforeNoToolCalls?(ctx: {
    context: Context;
    llmResponse: LLMResponse;
    turn: number;
  }): Promise<{ shouldEnd?: boolean }>;

  /**
   * 判断是否需要等待钩子
   *
   * 调用时机：检测到 wait 工具被调用时
   * 典型用途：子代理 wait 机制
   *
   * @returns 返回 true 表示需要等待
   */
  shouldWaitForSubAgent?(ctx: {
    waitCalled: boolean;
    context: Context;
    turn: number;
  }): Promise<boolean>;

  /**
   * 等待完成回调钩子
   *
   * 调用时机：shouldWaitForSubAgent 返回 true 且等待完成后
   * 典型用途：将等待结果注入上下文
   */
  afterWait?(ctx: {
    result: { agentId: string; message: string };
    context: Context;
    turn: number;
  }): Promise<void>;

  /**
   * 达到最大轮次钩子
   *
   * 调用时机：ReAct 循环达到 maxTurns 限制时
   * 典型用途：子代理中断回传父代理
   */
  onMaxTurnsReached?(ctx: {
    context: Context;
    result: string;
    turn: number;
    agentId?: string;
  }): Promise<void>;
}

/**
 * Feature 上下文值类型
 */
export type ToolContextValue = Record<string, unknown>;

/**
 * Feature 上下文注入器
 * 返回要注入到 tool.execute() 的额外参数
 */
export type ContextInjector = (call: ToolCall) => ToolContextValue;

/**
 * Feature 初始化上下文
 */
export interface FeatureInitContext {
  /** Agent ID */
  agentId: string;
  /** Agent 配置 */
  config: import('./types.js').AgentConfig;
  /** Feature 特定配置 */
  featureConfig?: unknown;
  /** 获取其他 Feature */
  getFeature<T extends AgentFeature>(name: string): T | undefined;
  /** 注册工具 */
  registerTool(tool: Tool): void;
}

/**
 * Feature 运行时上下文
 */
export interface FeatureContext {
  agentId: string;
  config: import('./types.js').AgentConfig;
}

/**
 * Agent Feature 接口
 *
 * 可外挂的功能模块，提供工具和上下文注入
 */
export interface AgentFeature {
  /** Feature 名称 */
  readonly name: string;
  /** 依赖的其他 Feature */
  readonly dependencies?: string[];

  /**
   * 获取同步工具（已知工具列表）
   */
  getTools?(): Tool[];

  /**
   * 获取异步工具（需要连接、发现等）
   */
  getAsyncTools?(ctx: FeatureInitContext): Promise<Tool[]>;

  /**
   * 声明上下文注入器
   */
  getContextInjectors?(): Map<string | RegExp, ContextInjector>;

  /**
   * 初始化钩子
   */
  onInitiate?(ctx: FeatureInitContext): Promise<void>;

  /**
   * 清理钩子
   */
  onDestroy?(ctx: FeatureContext): Promise<void>;

  /**
   * 声明 ReAct 循环钩子（可选）
   *
   * 只有需要介入 ReAct 循环执行流程的 Feature 才需要实现
   * 例如：SubAgentFeature 需要在工具调用后消费子代理消息
   *
   * @returns ReAct 循环钩子对象，不需要介入则返回 undefined
   */
  getReActLoopHooks?(): ReActLoopHooks | undefined;
}
