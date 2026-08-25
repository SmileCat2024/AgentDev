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
export { createLogger, emitLog, installConsoleBridge, runWithLogScope } from './core/logging.js';
export type { Logger, LoggerBindings } from './core/logging.js';
export { createLLMRetry, emitNotification, createLLMCharCount, createLLMComplete, createToolProgress } from './core/notification.js';

// LLM 重试与错误分类契约（ReAct 循环与 @agentdev/llm 共同消费）
export {
  ClassifiedAPIError,
  classifyAPIError,
  classifyAndWrapError,
  extractConnectionErrorDetails,
  getUserFriendlyMessage,
} from './core/api-errors.js';
export type { APIErrorType, ConnectionErrorDetails } from './core/api-errors.js';
export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODEL_MAX_RETRIES,
  DEFAULT_MODEL_TIMEOUT_MS,
  parseRetryAfter,
  getRetryDelay,
  shouldRetry,
  extractErrorCode,
  sleep,
  withDeadline,
  resolveModelCallPolicy,
} from './core/retry.js';
export type { LLMRetryData, ToolProgressData } from './core/notification.js';
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

// Hook 注册表（inspector 快照契约消费方，如 @agentdev/viewer）
export { HooksRegistry } from './core/hooks-registry.js';

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
// 注：LLM 实现（AnthropicLLM / OpenAILLM / OpenAIResponsesLLM / createLLM / compile*）
// 已拆分到 @agentdev/llm 包；此处仅保留 LLM 契约类型（见下方 core/types.js 导出）。

// 配置
export { loadConfig, loadConfigSync, listConfigs } from './core/config.js';
// Feature 配置队列解析（merge 与 provenance 的唯一权威实现，纯函数）
export { resolveFeatureConfig } from './core/feature-config.js';
export type {
  FeatureConfig,
  ConfigProvenanceEntry,
  ConfigWarning,
  ResolvedFeatureConfig,
} from './core/feature-config.js';
export { getDebugCapabilities } from './core/debug-capabilities.js';
export { getClawRuntimeUrl, resolveDebugTransportMode } from './core/debug-transport.js';
export type { CustomHeaderEntry } from './core/config.js';

// Viewer
// 注：ViewerWorker / viewer-html / 调试 MCP server 已拆分到 @agentdev/viewer 包。
export { getDefaultUDSPath } from './core/types.js';

// 渲染（Render）契约：@agentdev/viewer 与 @agentdev/mcp 共同消费
export {
  RENDER_TEMPLATES,
  SYSTEM_RENDER_MAP,
  TOOL_DISPLAY_NAMES,
  interpolateTemplate,
  applyTemplate,
  loadRenderTemplate,
  getToolRenderConfig,
  getToolRenderTemplate,
  getToolDisplayName,
} from './core/render.js';
export type { RenderTemplate } from './core/render.js';

// 模板系统
export * from './template/index.js';

// Skills 系统
export * from './skills/index.js';

// MCP
// 注：MCP 集成实现（连接管理 / 工具挂载 / MCPFeature）已拆分到 @agentdev/mcp 包；
// 此处仅保留 MCP 契约类型（AgentConfig.mcp 等框架契约依赖，见下方导出）。

// 类型
export type {
  Message,
  MessageRole,
  MessageUsage,
  Tool,
  ToolCall,
  ToolExecutionContext,
  ToolResultValue,
  ToolTerminationReason,
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
  // LLM 契约类型（@agentdev/llm 消费）
  LLMChatOptions,
  LLMPhase,
  ThinkingBlock,
  // 调试 / 通知快照类型（@agentdev/viewer 与下游 UI 消费）
  DebugLogEntry,
  AgentLogsResponse,
  AgentOverviewSnapshot,
  HookInspectorSnapshot,
  TodoPlanSnapshot,
  TodoTaskSnapshot,
  Notification,
  InputLease,
  QueuedInput,
  RequestInputMsg,
  InputRequestCancelledMsg,
  UserInputResponse,
  UserInputAction,
} from './core/types.js';
export type { DebugCapabilities } from './core/debug-capabilities.js';
export type { AgentSessionSnapshot, SessionStore, NamedCheckpoint } from './core/session-store.js';
export type { FeatureCheckpoint } from './core/checkpoint.js';

// MCP 契约类型（@agentdev/mcp 实现层消费并 re-export）
export type {
  MCPTransportType,
  MCPServerConfig,
  MCPSstdioConfig,
  MCPHTTPConfig,
  MCPSSEConfig,
  MCPConfig,
  MCPToolMappingConfig,
} from './core/mcp-contract.js';

// Session Continuity 契约层（ticket 005；006/007 官方实现与 WorkThread 消费）
export type {
  SessionTransformation,
  TransformInput,
  TransformContext,
  SuccessorSeed,
  SessionSeedMessage,
  SessionContinuityEntry,
} from './core/continuity/index.js';

// Session Continuity 官方变换实现（ticket 006）
export {
  DEFAULT_EXPORT_POLICY,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_COMPILER_VERSION,
  normalizeExportPolicy,
  buildTrimmedSeedMessages,
  TrimTranscriptTransformation,
  buildSummaryPrompt,
  stripCompactAnalysis,
  scanFilesAndSkills,
  normalizeSummaryPolicy,
  buildSummarySeedMessage,
  generateSummaryText,
  SummaryTransformation,
  TrimTranscriptWithSummaryTransformation,
} from './core/continuity/transforms/index.js';
export type {
  TrimExportPolicy,
  TrimStats,
  TrimmedSeedResult,
  TrimTranscriptTransformationOptions,
  SummaryPromptOptions,
  ScanFilesAndSkillsResult,
  SummaryExportPolicy,
  SummaryTransformationOptions,
  TrimTranscriptWithSummaryOptions,
} from './core/continuity/transforms/index.js';

// Continuity Participant 中性化协议层（ticket 006）
export {
  CONTINUITY_FIELD_KEY,
  GENERIC_CONTINUITY_PROTOCOL,
  OPENCODE_BASIC_CONTINUITY_PROTOCOL,
  readContinuityDescriptor,
  stripContinuityField,
  declareContinuity,
} from './core/continuity/participant.js';
export type { AgentdevContinuityDescriptor } from './core/continuity/participant.js';

// WorkThread 锚点层 + 可选看板（ticket 007）
export { WorkThread, WorkThreadNotFoundError } from './core/workthread/index.js';
export { WorkThreadBoard } from './core/workthread/index.js';
export { WorkThreadStore, WorkThreadRevisionConflictError } from './core/workthread/index.js';
export { WorkThreadRuntimeBridge } from './core/workthread/index.js';
export {
  WorkThreadCommandStatus,
  WorkThreadCommandKind,
  generateWorkThreadId,
} from './core/workthread/index.js';
export type {
  WorkThreadStartOptions,
  WorkThreadOptions,
  WorkThreadRecord,
  WorkThreadChainEntry,
  WorkThreadPendingSuccession,
  WorkThreadStatus,
  WorkThreadCommand,
  WorkThreadBoardStatus,
  WorkThreadBoardMode,
  WorkThreadBoardState,
  WorkThreadBridge,
  WorkThreadDeliveryOutcome,
} from './core/workthread/index.js';

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

// Capability 能力注册表（统一控制面）
export { CapabilityRegistry } from './core/capability.js';
export type {
  CapabilityDefinition,
  CapabilityContext,
  CapabilityInvokeResult,
  CapabilitySnapshot,
  CapabilityEntryPoint,
} from './core/capability.js';
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

// Agent 类型
export type {
  BasicAgentConfig,
  SystemContext,
} from './agents/index.js';
