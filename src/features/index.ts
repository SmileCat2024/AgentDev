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
  ReActLoopHooks,
} from '../core/feature.js';

// ContextFeature (已废弃，保留仅用于向后兼容)
/** @deprecated 使用 Context 类代替 */
export { ContextFeature } from './context.js';
/** @deprecated 使用 Context 类代替 */
export { ContextQuery } from './context.js';
/** @deprecated 使用 src/core/types.ts 中的类型 */
export type {
  MessageTag,
  ParsedContent,
  EnrichedMessage,
  FeedMetadata,
  ContextFeatureConfig,
} from '../core/context-types.js';

// MCP Feature
export { MCPFeature } from './mcp.js';

// Skill Feature
export { SkillFeature } from './skill.js';
export type { SkillFeatureConfig } from './skill.js';

// SubAgent Feature
export { SubAgentFeature, AgentPool } from './subagent.js';

// Todo Feature
export { TodoFeature } from './todo.js';
export type { TodoTask, TodoTaskSummary, TaskStatus, TodoFeatureConfig } from './todo.js';
