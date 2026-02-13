/**
 * AgentDev - 轻量级 Agent 框架
 *
 * 所有导出都在这里，一目了然
 */

// 核心
export { Agent } from './core/agent.js';
export { Context } from './core/context.js';
export { createTool, ToolRegistry } from './core/tool.js';
export { runReactLoop } from './core/loop.js';
export { MessageViewer } from './core/viewer.js';
export { DebugHub } from './core/debug-hub.js';

// 生命周期类型
export type { ToolContext, ToolResult, HookResult } from './core/lifecycle.js';

// 系统工具
export * as fsTools from './tools/fs.js';
export * as shellTools from './tools/shell.js';
export * as webTools from './tools/web.js';
export * as mathTools from './tools/math.js';
export * as skillTools from './tools/skill.js';

// 消息
export { system, user, assistant, toolResult, createMessage } from './core/message.js';

// LLM
export { OpenAILLM, createOpenAILLM } from './llm/openai.js';

// 配置
export { loadConfig, listConfigs } from './core/config.js';

// 模板系统
export * from './template/index.js';

// Skills 系统
export * from './skills/index.js';

// 类型
export type {
  Message,
  MessageRole,
  Tool,
  ToolCall,
  LLMResponse,
  LLMClient,
  AgentConfig,
  ContextMiddleware,
  ToolRenderConfig,
  ToolMetadata,
  AgentInfo,
  AgentSession,
  DebugHubIPCMessage,
} from './core/types.js';

export type { ModelConfig, AgentConfigFile } from './core/config.js';

// 模板系统类型
export type {
  TemplateSource,
  PlaceholderContext,
  TemplateResult,
  TemplateLoaderOptions,
  CacheStats,
} from './template/types.js';
