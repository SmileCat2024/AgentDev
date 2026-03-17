/**
 * AgentDev - 轻量级 Agent 框架
 *
 * 所有导出都在这里，一目了然
 */

// 核心
export { Agent } from './core/agent.js';
export { Context } from './core/context.js';
export { createTool, ToolRegistry } from './core/tool.js';
export { DebugHub } from './core/debug-hub.js';
export { FileSessionStore, getDefaultSessionStore } from './core/session-store.js';

// Feature 系统
export * from './features/index.js';

// 预置 Agent 类
export * from './agents/index.js';

// 生命周期类型
export type { ToolContext, ToolResult, HookResult, AgentInitiateContext } from './core/lifecycle.js';

// 注意：所有工具现在通过 Feature 系统提供
// - 文件操作工具：OpencodeBasicFeature
// - 系统工具（web_fetch, calculator）：SystemToolsFeature
// - Shell 工具：ShellFeature（独立包 @agentdev/shell-feature）
// - Skill 工具：SkillFeature

// 消息
export { system, user, assistant, toolResult, createMessage } from './core/message.js';

// LLM
export {
  AnthropicLLM,
  OpenAILLM,
  compileContextForAnthropic,
  createAnthropicLLM,
  createLLM,
  createOpenAILLM,
} from './llm/index.js';

// 配置
export { loadConfig, loadConfigSync, listConfigs } from './core/config.js';
export { getDebugCapabilities } from './core/debug-capabilities.js';
export { getClawRuntimeUrl, resolveDebugTransportMode } from './core/debug-transport.js';

// Viewer
export { ViewerWorker } from './core/viewer-worker.js';
export { getDefaultUDSPath } from './core/types.js';

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
export type { DebugCapabilities } from './core/debug-capabilities.js';
export type { AgentSessionSnapshot, SessionStore } from './core/session-store.js';

// Feature 类型
export type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  ContextInjector,
  ToolContextValue,
  FeatureStateSnapshot,
  PackageInfo,
} from './core/feature.js';

// 重新导出核心功能模块
export { getPackageInfoFromSource } from './core/feature.js';
export { CallStart } from './core/hooks-decorator.js';
export type { CallStartContext } from './core/lifecycle.js';

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
  MCPSSEConfig,
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
