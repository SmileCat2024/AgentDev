/**
 * Feature System - 可外挂功能模块接口
 *
 * Feature 系统允许将功能（MCP、Skills、子代理等）从 Agent 核心中解耦，
 * 实现新功能的声明式注册和统一的生命周期管理。
 */

import type { Tool } from './types.js';
import type { ToolCall } from './types.js';

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
}
