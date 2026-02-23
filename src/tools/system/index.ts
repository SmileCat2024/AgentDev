/**
 * 系统工具统一导出
 * 包含所有内置系统工具及其渲染模板
 */

// 导出工具
export { readFileTool, writeFileTool, listDirTool } from './fs.js';
export { shellTool } from './shell.js';
export { webFetchTool } from './web.js';
export { calculatorTool } from './math.js';
export { invokeSkillTool } from './skill.js';
export { spawnAgentTool, listAgentsTool, sendToAgentTool, closeAgentTool, waitTool } from './subagent.js';

// 导出渲染模板
export { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
export { shellCommandRender } from './shell.render.js';
export { webFetchRender } from './web.render.js';
export { calculatorRender } from './math.render.js';
export { invokeSkillRender } from './skill.render.js';
export { spawnAgentRender, listAgentsRender, sendToAgentRender, closeAgentRender, waitRender } from './subagent.render.js';

// 导入工具和渲染模板
import { readFileTool, writeFileTool, listDirTool } from './fs.js';
import { shellTool } from './shell.js';
import { webFetchTool } from './web.js';
import { calculatorTool } from './math.js';
import { invokeSkillTool } from './skill.js';
import { spawnAgentTool, listAgentsTool, sendToAgentTool, closeAgentTool, waitTool } from './subagent.js';

import { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
import { shellCommandRender } from './shell.render.js';
import { webFetchRender } from './web.render.js';
import { calculatorRender } from './math.render.js';
import { invokeSkillRender } from './skill.render.js';
import { spawnAgentRender, listAgentsRender, sendToAgentRender, closeAgentRender, waitRender } from './subagent.render.js';

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

  // SubAgent 工具
  spawnAgentTool,
  listAgentsTool,
  sendToAgentTool,
  closeAgentTool,
  waitTool,
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

  // Shell 工具
  'run_shell_command': shellCommandRender,

  // Web 工具
  'web_fetch': webFetchRender,

  // Math 工具
  'calculator': calculatorRender,

  // Skills 工具
  'invoke_skill': invokeSkillRender,

  // SubAgent 工具
  'spawn_agent': spawnAgentRender,
  'list_agents': listAgentsRender,
  'send_to_agent': sendToAgentRender,
  'close_agent': closeAgentRender,
  'wait': waitRender,
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
