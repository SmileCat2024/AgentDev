/**
 * 系统工具渲染模板统一导出
 * 供前端 viewer-worker-frontend.ts 直接 import 使用
 *
 * 导出格式：
 * - 具名导出：export { spawnAgentRender, waitRender, ... }
 * - 映射表导出：export const TEMPLATES = { 'agent-spawn': spawnAgentRender, ... }
 */

// 导出各个渲染模板
export { spawnAgentRender, listAgentsRender, sendToAgentRender, closeAgentRender, waitRender } from './subagent.render.js';
export { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
export { shellCommandRender } from './shell.render.js';
export { webFetchRender } from './web.render.js';
export { calculatorRender } from './math.render.js';
export { invokeSkillRender } from './skill.render.js';
export { taskCreateRender, taskListRender, taskGetRender, taskUpdateRender, taskClearRender } from './todo.render.js';

// 导入以便创建映射表
import { spawnAgentRender, listAgentsRender, sendToAgentRender, closeAgentRender, waitRender } from './subagent.render.js';
import { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
import { shellCommandRender } from './shell.render.js';
import { webFetchRender } from './web.render.js';
import { calculatorRender } from './math.render.js';
import { invokeSkillRender } from './skill.render.js';
import { taskCreateRender, taskListRender, taskGetRender, taskUpdateRender, taskClearRender } from './todo.render.js';

/**
 * 模板 Key -> 渲染模板 映射表
 * Key 与工具定义中 render 字段的值对应
 *
 * 例如：spawnAgentTool.render = { call: 'agent-spawn', result: 'agent-spawn' }
 * 则 TEMPLATES['agent-spawn'] = spawnAgentRender
 */
export const TEMPLATES: Record<string, any> = {
  // SubAgent 工具
  'agent-spawn': spawnAgentRender,
  'agent-list': listAgentsRender,
  'agent-send': sendToAgentRender,
  'agent-close': closeAgentRender,
  'wait': waitRender,

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
  'skill': invokeSkillRender,
  'invoke_skill': invokeSkillRender,

  // Todo 工具
  'task-create': taskCreateRender,
  'task-list': taskListRender,
  'task-get': taskGetRender,
  'task-update': taskUpdateRender,
  'task-clear': taskClearRender,

  // 默认 fallback
  'json': {
    call: () => '<div class="bash-command">Tool call</div>',
    result: (data: any) => `<pre style="background:var(--bg-secondary); padding:8px; border-radius:4px; overflow:auto;">${JSON.stringify(data, null, 2)}</pre>`,
  },
};
