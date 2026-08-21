/**
 * AgentDev - 轻量级 Agent 框架
 *
 * 所有导出都在这里，一目了然
 */

// 核心
export { Agent } from './core/agent.js';
export { Context } from './core/context.js';
export type {
  ContextSnapshot,
  ContextBoundaryV2,
  ToolExecResult,
  ContextTombstoneSummary,
  ContextTombstoneEntry,
} from './core/context.js';
export { createTool, ToolRegistry } from './core/tool.js';
export { DebugHub } from './core/debug-hub.js';
export { createLogger, installConsoleBridge, runWithLogScope } from './core/logging.js';
export type { Logger, LoggerBindings } from './core/logging.js';
export { createLLMRetry } from './core/notification.js';
export type { LLMRetryData } from './core/notification.js';
export { subscribeSessionEvents, emitSessionEvent } from './core/session-events.js';
export type { SessionEvent, SessionItem, SessionEventListener, TurnUsage, TurnFailure } from './core/session-events.js';
export { FileSessionStore, getDefaultSessionStore } from './core/session-store.js';
export type {
  AgentRuntimeSnapshot,
  RuntimeStateWithoutContext,
  CallRollbackSnapshot,
  CallRollbackSnapshotV2,
  IncrementalCallRollbackSnapshot,
  LegacyCallRollbackSnapshot,
} from './core/session-store.js';

// 通知版实时运行时状态快照（notification API 的 runtime 字段类型）
export type { AgentRuntimeStateSnapshot, RuntimeStage } from './core/types.js';

// 用量统计（AgentRuntimeSnapshot.usageStats / Agent.getUsage() 的公共类型面）
export type { UsageInfo, UsageStatsSnapshot, CallUsageSummary } from './core/usage.js';
export type { UsageStats } from './core/usage.js'; // type-only，不扩大运行时面

// Feature 系统
export * from './features/index.js';

// 预置 Agent 类
export * from './agents/index.js';

// 生命周期类型
export { CoreLifecycle, Decision, normalizeDecision } from './core/lifecycle.js';
export type { ToolContext, ToolResult, HookResult, AgentInitiateContext, DecisionResult } from './core/lifecycle.js';

// 注意：所有工具现在通过 Feature 系统提供
// - 文件操作工具：OpencodeBasicFeature
// - 系统工具（web_fetch, calculator）：SystemToolsFeature
// - Shell 工具：ShellFeature（独立包 @agentdev/shell-feature）
// - Skill 工具：SkillFeature

// 消息
export { system, user, assistant, toolResult, createMessage } from './core/message.js';

// 工具图片注入
export { withImages, isWithImagesResult } from './core/tool-result-images.js';
export type { WithImagesResult } from './core/tool-result-images.js';

// LLM
export {
  AnthropicLLM,
  OpenAILLM,
  OpenAIResponsesLLM,
  compileChatMessages,
  compileContextForAnthropic,
  compileContextForOpenAIResponses,
  createAnthropicLLM,
  createLLM,
  createOpenAILLM,
  createOpenAIResponsesLLM,
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
  MessageUsage,
  Tool,
  ToolCall,
  ToolExecutionContext,
  ToolResultValue,
  LLMResponse,
  LLMClient,
  LLMMeta,
  AgentConfig,
  ContextMiddleware,
  ToolRenderConfig,
  InlineRenderTemplate,
  ToolMetadata,
  AgentInfo,
  AgentSession,
  DebugHubIPCMessage,
  ImageInput,
  UserTurnInput,
  UserTurnSubmissionResult,
  EnrichedMessage,
  MessageTag,
  ParsedContent,
} from './core/types.js';
export type { DebugCapabilities } from './core/debug-capabilities.js';
export type { AgentSessionSnapshot, SessionStore, NamedCheckpoint } from './core/session-store.js';
export type { FeatureCheckpoint } from './core/checkpoint.js';

// Continuation request 类型
export type {
  CallContinuationRequest,
  CheckpointContinuationRequest,
  RollbackContinuationRequest,
} from './core/continuation.js';

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
export type { FeatureManifestDefinition, FeatureManifestSettingProperty } from './core/feature.js';
export { preflightAssembly } from './core/feature-preflight.js';
export type {
  PreflightCheck,
  PreflightIssue,
  PreflightAssembly,
  PreflightResult,
} from './core/feature-preflight.js';
export {
  readHookDeclarations,
  validateHookDeclarations,
  validatePolicyUniqueness,
} from './core/hook-declarations.js';
export type {
  HookKind,
  GuardRole,
  HookDeclaration,
  HookDeclarations,
  HookDeclarationIssue,
  HookDeclarationIssueCode,
  AgentInitiateHook,
  AgentDestroyHook,
  CallStartHook,
  CallFinishHook,
  StepStartHook,
  StepFinishHook,
  ToolUseHook,
  ToolFinishedHook,
  ToolResultTransformHook,
} from './core/hook-declarations.js';
export type {
  CallStartContext,
  CallFinishContext,
  StepStartContext,
  StepFinishedContext,
  StepFinishDecisionContext,
  ToolFinishedDecisionContext,
  ToolResultTransformContext,
} from './core/lifecycle.js';
export type {
  CallFinishReason,
  ExecutionStatus,
  ExecutionReason,
  ExecutionError,
  ModelRequestOutcome,
  CallOutcome,
} from './core/lifecycle.js';
export type { MessageExecutionMeta } from './core/types.js';

export type { ModelConfig, AgentConfigFile, ThinkingEffort } from './core/config.js';
export { OPENAI_THINKING_EFFORTS, ANTHROPIC_THINKING_EFFORTS } from './core/config.js';

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
