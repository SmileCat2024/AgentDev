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

// 预置 Agent 类
export * from './agents/index.js';

// 工具加载器
export { loadToolsFromDir, loadSystemTools, loadUserTools, loadAllTools } from './tools/loader.js';

// 生命周期类型
export type { ToolContext, ToolResult, HookResult } from './core/lifecycle.js';

// 系统工具
export * as fsTools from './tools/system/fs.js';
export * as shellTools from './tools/system/shell.js';
export * as webTools from './tools/system/web.js';
export * as mathTools from './tools/system/math.js';
export * as skillTools from './tools/system/skill.js';

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

// MCP 集成
export * from './mcp/index.js';

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
  InlineRenderTemplate,
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

// MCP 类型
export type {
  MCPServerConfig,
  MCPSstdioConfig,
  MCPHTTPConfig,
  MCPConfig,
  MCPConnectionInfo,
  MCPToolResult,
  MCPStatistics,
} from './mcp/types.js';

// Agent 类型
export type {
  BasicAgentConfig,
  SystemContext,
} from './agents/index.js';
