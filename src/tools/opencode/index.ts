/**
 * Opencode 工具统一导出
 * 来自 opencode 项目的优秀基础文件工具实现
 */

// 导出工具
export { globTool } from './glob.js';
export { grepTool } from './grep.js';
export { lsTool } from './ls.js';
export { readTool } from './read.js';
export { writeTool } from './write.js';
export { editTool } from './edit.js';

// 导出渲染模板
export { globRender } from './glob.render.js';
export { grepRender } from './grep.render.js';
export { lsRender } from './ls.render.js';
export { readRender } from './read.render.js';
export { writeRender } from './write.render.js';
export { editRender } from './edit.render.js';

// 导入工具
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { lsTool } from './ls.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';

// 导入渲染模板
import { globRender } from './glob.render.js';
import { grepRender } from './grep.render.js';
import { lsRender } from './ls.render.js';
import { readRender } from './read.render.js';
import { writeRender } from './write.render.js';
import { editRender } from './edit.render.js';

/**
 * 所有 opencode 工具
 */
export const OPENCODE_TOOLS = [
  globTool,
  grepTool,
  lsTool,
  readTool,
  writeTool,
  editTool,
] as const;

/**
 * Opencode 工具渲染模板映射
 */
export const OPENCODE_RENDER_TEMPLATES: Record<string, any> = {
  'glob': globRender,
  'grep': grepRender,
  'ls': lsRender,
  'read': readRender,
  'write': writeRender,
  'edit': editRender,
};

/**
 * 按名称索引的工具映射
 */
export const OPENCODE_TOOLS_MAP = new Map(
  OPENCODE_TOOLS.map(tool => [tool.name, tool])
);

/**
 * 获取 opencode 工具
 */
export function getOpencodeTool(name: string) {
  return OPENCODE_TOOLS_MAP.get(name);
}

/**
 * 检查是否为 opencode 工具
 */
export function isOpencodeTool(name: string): boolean {
  return OPENCODE_TOOLS_MAP.has(name);
}
