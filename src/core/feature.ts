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
  /** Feature 级结构化日志 */
  logger: import('./logging.js').Logger;
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

// ========== 正向钩子（纯通知，void 返回）==========

/**
 * Feature 初始化上下文
 */
export interface FeatureInitContext {
  /** Agent ID */
  agentId: string;
  /** Agent 配置 */
  config: import('./types.js').AgentConfig;
  /** Feature 级结构化日志 */
  logger: import('./logging.js').Logger;
  /** Feature 特定配置 */
  featureConfig?: unknown;
  /** 获取其他 Feature */
  getFeature<T extends AgentFeature>(name: string): T | undefined;
  /** 注册工具 */
  registerTool(tool: Tool): void;
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
  /** 可选：用于调试器展示的源码位置 */
  readonly source?: string;
  /** 可选：用于调试器展示的 Feature 描述 */
  readonly description?: string;

  /**
   * 获取同步工具（已知工具列表）
   */
  getTools?(): Tool[];

  /**
   * 获取异步工具（需要连接、发现等）
   */
  getAsyncTools?(ctx: FeatureInitContext): Promise<Tool[]>;

  /**
   * 声明渲染模板路径
   * 返回模板名到文件路径的映射，用于 ViewerWorker 动态加载
   */
  getTemplatePaths?(): Record<string, string>;

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
   * 可选：为调试器提供 hook 的人类可读说明
   */
  getHookDescription?(lifecycle: string, methodName: string): string | undefined;

  // ========== 反向钩子通过装饰器注册，无需接口声明 ==========
  // 使用 hooks-decorator.ts 中提供的装饰器来标记反向钩子方法
  // 例如：@ToolFinished, @LLMFinish, @StepFinish 等
}
