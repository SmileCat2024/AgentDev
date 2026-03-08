/**
 * Features 模块导出
 *
 * 统一导出所有 Feature 实现
 */

// Core types
export type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  ContextInjector,
  ToolContextValue,
} from '../core/feature.js';

// MCP Feature
export { MCPFeature } from './mcp/index.js';

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

// Shell Feature
export { ShellFeature } from './shell/index.js';

// Audit Feature
export { AuditFeature } from './audit/index.js';
export type { AuditResult, AuditFeatureConfig } from './audit/index.js';

// OpencodeBasic Feature
export { OpencodeBasicFeature } from './opencode-basic/index.js';

// Visual Feature
export { VisualFeature } from './visual/index.js';
export type { WindowInfo, CaptureResult, VisualUnderstandingResult, VisualFeatureConfig } from './visual/index.js';
