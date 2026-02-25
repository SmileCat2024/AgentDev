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
export { MCPFeature } from './mcp.js';

// Skill Feature
export { SkillFeature } from './skill.js';
export type { SkillFeatureConfig } from './skill.js';
