/**
 * Features 模块导出
 *
 * @agentdevjs/core 内置的轻量 Features（零原生依赖、零重 SDK，白名单验证通过）：
 * lsp / todo / user-input / skill / subagent / file-history / opencode-basic /
 * output-guard，外加框架原生的 handoff-seed（continuity 基座）与
 * example-feature（开发参考骨架）。
 *
 * 其余 Features 为独立生态包（@agentdevjs/feature-* / @agentdevjs/mcp），
 * 需要单独安装：
 *   - shell / audit / audio-feedback / memory / qqbot / tts / visual /
 *     websearch / plugin-compat 等
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

// Skill Feature
export { SkillFeature } from './skill/index.js';
export type { SkillFeatureConfig } from './skill/index.js';

// SubAgent Feature
export { SubAgentFeature, AgentPool } from './subagent/index.js';

// Todo Feature
export { TodoFeature } from './todo/index.js';
export type { TodoTask, TodoTaskSummary, TaskStatus, TodoFeatureConfig } from './todo/index.js';

// UserInput Feature
export { UserInputFeature } from './user-input/index.js';
export type { UserInputFeatureConfig } from './user-input/index.js';

// File History Feature
export { FileHistoryFeature } from './file-history/index.js'
export type { FileHistoryFeatureConfig, SnapshotInfo } from './file-history/index.js'

// Handoff Seed Feature
export { HandoffSeedFeature } from './handoff-seed/index.js';
export type {
  HandoffSeedFeatureConfig,
  HandoffSeedPayload,
  HandoffSeedMessage,
  HandoffSeedSnapshot,
} from './handoff-seed/types.js';

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

// OutputGuard Feature
export { OutputGuardFeature } from './output-guard/index.js';
export type { OutputGuardConfig } from './output-guard/index.js';
export {
  truncateOutput,
  truncateJsonNode,
  shrinkArray,
  tryJsonTruncate,
  truncateByLines,
  truncateHeadTail,
  DEFAULT_HARD_LIMIT,
  DEFAULT_FIELD_LIMIT,
} from './output-guard/truncate.js';
export type { TruncateOptions, TruncateResult } from './output-guard/truncate.js';
