/**
 * 系统工具渲染模板统一导出
 * 供前端 viewer-worker-frontend.ts 直接 import 使用
 */

// 导出各个渲染模板
export { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
export { webFetchRender } from './web.render.js';
export { calculatorRender } from './math.render.js';
export { commandRender, bashRender, shellRender } from './shell.render.js';

// 导入以便创建映射表
import { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
import { webFetchRender } from './web.render.js';
import { calculatorRender } from './math.render.js';
import { commandRender, bashRender, shellRender } from './shell.render.js';

/**
 * 模板 Key -> 渲染模板 映射表
 * Key 与工具定义中 render 字段的值对应
 */
export const TEMPLATES: Record<string, any> = {
  // 文件系统工具
  'read_file': readFileRender,
  'write_file': writeFileRender,
  'list_directory': listDirRender,

  // Web 工具
  'web_fetch': webFetchRender,

  // Math 工具
  'calculator': calculatorRender,

  // Shell/Bash 工具
  'command': commandRender,
  'bash': bashRender,
  'shell': shellRender,

  // 默认 fallback
  'json': {
    call: () => '<div class="bash-command">Tool call</div>',
    result: (data: any) => `<pre style="background:var(--bg-secondary); padding:8px; border-radius:4px; overflow:auto;">${JSON.stringify(data, null, 2)}</pre>`,
  },
};
