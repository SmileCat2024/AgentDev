/**
 * 系统工具索引
 * 统一导出所有系统工具
 */

// 文件系统工具
export { readFileTool, writeFileTool, listDirTool } from './fs.js';
export { shellTool } from './shell.js';
export { webFetchTool } from './web.js';
export { calculatorTool } from './math.js';
export { invokeSkillTool } from './skill.js';

// 为了方便使用，也可以导出所有工具的数组
import { readFileTool, writeFileTool, listDirTool } from './fs.js';
import { shellTool } from './shell.js';
import { webFetchTool } from './web.js';
import { calculatorTool } from './math.js';
import { invokeSkillTool } from './skill.js';

/**
 * 所有系统工具
 */
export const SYSTEM_TOOLS = [
  // 文件系统工具
  readFileTool,
  writeFileTool,
  listDirTool,

  // Shell 工具
  shellTool,

  // Web 工具
  webFetchTool,

  // 数学工具
  calculatorTool,

  // Skills 工具
  invokeSkillTool,
] as const;

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
