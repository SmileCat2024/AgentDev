/**
 * Features 模块导出
 *
 * 框架内置 Features（打包进 agentdev npm 包）
 *
 * 注意：
 * - 以下 Features 会随 agentdev 包一起发布
 * - 其他 Features 作为独立包发布，需要单独安装：
 *   - @agentdev/shell-feature (shell 执行和回收站功能)
 *   - @agentdev/visual-feature (视觉理解，需要 Python 环境)
 *   - @agentdev/websearch-feature (网页抓取)
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

// OpencodeBasic Feature
export { OpencodeBasicFeature } from './opencode-basic/index.js';

// Example Feature Skeleton (用于开发参考)
export { ExampleFeature } from './example-feature/index.js';
export type {
  ExampleFeatureConfig,
  ExampleFeatureRuntimeState,
  ExampleFeatureSnapshot,
} from './example-feature/types.js';
