/**
 * 系统工具统一导出
 * 包含所有内置系统工具及其渲染模板
 *
 * 注意：
 * - Shell 工具已迁移到 src/features/shell/ (ShellFeature)
 * - Skill 工具已迁移到 src/features/skill/ (SkillFeature)
 * - SubAgent 工具已迁移到 src/features/subagent/ (SubAgentFeature)
 * - Todo 工具已迁移到 src/features/todo/ (TodoFeature)
 */

// 导出工具
export { readFileTool, writeFileTool, listDirTool } from './fs.js';
export { webFetchTool } from './web.js';
export { calculatorTool } from './math.js';

// 导出渲染模板
export { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
export { webFetchRender } from './web.render.js';
export { calculatorRender } from './math.render.js';

// 导入以便在内部使用
import { readFileTool, writeFileTool, listDirTool } from './fs.js';
import { webFetchTool } from './web.js';
import { calculatorTool } from './math.js';

import { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
import { webFetchRender } from './web.render.js';
import { calculatorRender } from './math.render.js';

/**
 * 所有系统工具
 * 注意：Shell、Skill、SubAgent、Todo 工具已迁移到各自的 Feature 模块
 */
export const SYSTEM_TOOLS = [
  // 文件系统工具
  readFileTool,
  writeFileTool,
  listDirTool,

  // Web 工具
  webFetchTool,

  // 数学工具
  calculatorTool,

  // Shell 工具已迁移到 ShellFeature
  // Skill 工具已迁移到 SkillFeature
  // SubAgent 工具已迁移到 SubAgentFeature
  // Todo 工具已迁移到 TodoFeature
] as const;

/**
 * 系统工具渲染模板映射
 * 工具名称 -> 渲染模板
 */
export const SYSTEM_RENDER_TEMPLATES: Record<string, any> = {
  // 文件系统工具
  'read_file': readFileRender,
  'write_file': writeFileRender,
  'list_directory': listDirRender,

  // Web 工具
  'web_fetch': webFetchRender,

  // Math 工具
  'calculator': calculatorRender,

  // Shell 渲染模板已迁移到 ShellFeature
  // Skill 渲染模板已迁移到 SkillFeature
  // SubAgent 渲染模板已迁移到 SubAgentFeature
  // Todo 渲染模板已迁移到 TodoFeature
};

/**
 * 按名称索引的工具映射
 */
export const SYSTEM_TOOLS_MAP = new Map(
  SYSTEM_TOOLS.map(tool => [tool.name, tool])
);

/**
 * 获取系统工具
 */
export function getSystemTool(name: string) {
  return SYSTEM_TOOLS_MAP.get(name);
}

/**
 * 检查是否为系统工具
 */
export function isSystemTool(name: string): boolean {
  return SYSTEM_TOOLS_MAP.has(name);
}
