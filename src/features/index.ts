/**
 * Features 模块导出
 *
 * 框架内置 Features（打包进 agentdev npm 包）
 *
 * 注意：
 * - 以下 Features 会随 agentdev 包一起发布
 * - 其他 Features 作为独立包发布，需要单独安装：
 *   - 某些 Feature 同时存在框架内置版和独立包版；顶层导出应保持完整，避免 example/独立包消费时缺符号
 */

// Core types
export type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  ContextInjector,
  ToolContextValue,
  PackageInfo,
} from '../core/feature.js';

// MCP Feature
export { MCPFeature } from './mcp/index.js';
export type { MCPFeatureOptions } from './mcp/index.js';

// Audit Feature
export { AuditFeature } from './audit/index.js';
export type { AuditFeatureConfig } from './audit/index.js';

// Audio Feedback Feature
export { AudioFeedbackFeature } from './audio-feedback/index.js';

// Memory Feature
export { MemoryFeature } from './memory/index.js';
export type { MemoryFeatureConfig } from './memory/index.js';

// Skill Feature
export { SkillFeature } from './skill/index.js';
export type { SkillFeatureConfig } from './skill/index.js';

// Plugin Compatibility Feature
export { PluginCompatFeature } from './plugin-compat/index.js';

// Shell Feature
export { ShellFeature } from './shell/index.js';

// SubAgent Feature
export { SubAgentFeature, AgentPool } from './subagent/index.js';

// Todo Feature
export { TodoFeature } from './todo/index.js';
export type { TodoTask, TodoTaskSummary, TaskStatus, TodoFeatureConfig } from './todo/index.js';

// TTS Feature
export { TTSFeature } from './tts/index.js';
export type { TTSFeatureConfig, TTSResult, TTSState } from './tts/index.js';

// UserInput Feature
export { UserInputFeature } from './user-input/index.js';
export type { UserInputFeatureConfig } from './user-input/index.js';

// Visual Feature
export { VisualFeature } from './visual/index.js';
export type {
  WindowInfo,
  CaptureResult,
  VisualUnderstandingResult,
  VisualFeatureConfig,
} from './visual/index.js';

// WebSearch Feature
export { WebSearchFeature } from './websearch/index.js';
export type { WebSearchFeatureConfig } from './websearch/index.js';

// File History Feature
export { FileHistoryFeature } from './file-history/index.js'
export type { FileHistoryFeatureConfig, SnapshotInfo } from './file-history/index.js'

// OpencodeBasic Feature
export { OpencodeBasicFeature } from './opencode-basic/index.js';

// Example Feature Skeleton (用于开发参考)
export { ExampleFeature } from './example-feature/index.js';
export type {
  ExampleFeatureConfig,
  ExampleFeatureRuntimeState,
  ExampleFeatureSnapshot,
} from './example-feature/types.js';

// LSP Feature
export { LspFeature } from './lsp/index.js';
export type { LspFeatureConfig } from './lsp/index.js';
