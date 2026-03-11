/**
 * OpenClaw 兼容层类型定义
 */

import type { Tool, ToolCall, Message } from '../../core/types.js';
import type { Context } from '../../core/context.js';
import type { AgentConfig } from '../../core/types.js';

// ========== OpenClaw Plugin Manifest ==========

/**
 * OpenClaw 插件清单 (openclaw.plugin.json)
 */
export interface OpenClawPluginManifest {
  /** 插件唯一标识 */
  id: string;
  /** 插件名称 */
  name: string;
  /** 版本 */
  version: string;
  /** 描述 */
  description?: string;
  /** 入口文件路径 */
  main: string;
  /** 插件配置 schema */
  configSchema?: Record<string, unknown>;
}

// ========== OpenClaw Plugin API ==========

/**
 * 插件日志记录器
 */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * OpenClaw 兼容运行时
 */
export interface AgentDevOpenClawCompatRuntime {
  /** 工具调用 */
  tools: {
    invoke: (name: string, params: unknown) => Promise<unknown>;
  };
  /** 日志 */
  logging: {
    getChildLogger: (bindings?: Record<string, unknown>) => PluginLogger;
  };
  /** 状态 */
  state: {
    agentId: string;
  };
}

/**
 * OpenClaw 兼容 API
 *
 * 暴露给插件的 API，兼容 OpenClaw 插件接口
 */
export interface AgentDevOpenClawCompatApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: AgentConfig;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  runtime: AgentDevOpenClawCompatRuntime;

  // 支持的 API
  registerTool: (
    tool: CompatTool | CompatToolFactory,
    opts?: { optional?: boolean; name?: string; names?: string[] }
  ) => void;
  on: <K extends CompatHookName>(
    hookName: K,
    handler: CompatHookHandlerMap[K],
    opts?: { priority?: number }
  ) => void;
  resolvePath: (input: string) => string;

  // 不支持的 API（调用时抛出错误）
  registerChannel: never;
  registerGatewayMethod: never;
  registerHttpRoute: never;
  registerCli: never;
  registerService: never;
  registerProvider: never;
}

// ========== Compat 工具定义 ==========

/**
 * 兼容工具定义
 */
export interface CompatTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute: (params: { args: Record<string, unknown>; context: CompatToolContext }) => Promise<unknown>;
}

/**
 * 兼容工具工厂
 */
export type CompatToolFactory = (api: AgentDevOpenClawCompatApi) => CompatTool;

/**
 * 兼容工具上下文
 */
export interface CompatToolContext {
  /** 消息上下文 */
  messages: Message[];
  /** 当前工具调用 */
  call: ToolCall;
}

// ========== Compat 钩子定义 ==========

/**
 * 支持的兼容钩子名称
 */
export type CompatHookName =
  | 'before_tool_call'
  | 'after_tool_call';

/**
 * before_tool_call 钩子上下文
 */
export interface BeforeToolCallContext {
  /** 工具调用 */
  call: ToolCall;
  /** 工具名称 */
  toolName: string;
  /** 工具参数 */
  parameters: Record<string, unknown>;
  /** 消息历史 */
  messages: Message[];
}

/**
 * before_tool_call 钩子结果
 */
export interface BeforeToolCallResult {
  /** 是否阻止执行 */
  block?: boolean;
  /** 拒绝原因 */
  denyReason?: string;
  /** 修改后的参数 */
  rewrittenParameters?: Record<string, unknown>;
}

/**
 * after_tool_call 钩子上下文
 */
export interface AfterToolCallContext {
  /** 工具调用 */
  call: ToolCall;
  /** 工具名称 */
  toolName: string;
  /** 执行是否成功 */
  success: boolean;
  /** 执行结果 */
  result: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时(ms) */
  duration: number;
  /** 消息历史 */
  messages: Message[];
}

/**
 * 兼容钩子处理器映射
 */
export interface CompatHookHandlerMap {
  before_tool_call: (ctx: BeforeToolCallContext) => BeforeToolCallResult | Promise<BeforeToolCallResult>;
  after_tool_call: (ctx: AfterToolCallContext) => void | Promise<void>;
}

// ========== 插件记录 ==========

/**
 * 已注册的兼容钩子
 */
export interface RegisteredCompatHook {
  /** 插件 ID */
  pluginId: string;
  /** 钩子名称 */
  hookName: CompatHookName;
  /** 处理器 */
  handler: CompatHookHandlerMap[CompatHookName];
  /** 优先级（OpenClaw 规则：数值越大越先执行） */
  priority: number;
}

/**
 * 插件诊断信息
 */
export interface PluginDiagnostics {
  /** 插件 ID */
  pluginId: string;
  /** 插件名称 */
  name: string;
  /** 版本 */
  version: string;
  /** 源路径 */
  source: string;
  /** 注册的工具 */
  registeredTools: string[];
  /** 注册的钩子 */
  registeredHooks: CompatHookName[];
  /** 不支持的 API 调用记录 */
  unsupportedApis: string[];
  /** 错误信息 */
  errors: string[];
}

/**
 * 兼容层诊断报告
 */
export interface CompatDiagnosticsReport {
  /** 加载的插件列表 */
  plugins: PluginDiagnostics[];
  /** 总计注册的工具数 */
  totalTools: number;
  /** 总计注册的钩子数 */
  totalHooks: number;
}

// ========== 插件配置 ==========

/**
 * 插件兼容层配置
 */
export interface PluginCompatConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 插件根目录列表 */
  pluginRoots?: string[];
  /** 启用的兼容表面 */
  surfaces?: {
    /** 工具兼容 */
    tools?: boolean;
    /** 钩子兼容 */
    hooks?: boolean;
  };
}
