/**
 * 系统工具渲染模板统一导出
 * 供前端 viewer-worker-frontend.ts 直接 import 使用
 *
 * 注意：
 * - Shell 渲染模板已迁移到 src/features/shell/templates/
 * - Skill 渲染模板已迁移到 src/features/skill/templates/
 * - SubAgent 渲染模板已迁移到 src/features/subagent/templates/
 * - Todo 渲染模板已迁移到 src/features/todo/templates/
 *
 * 这里只保留仍在 tools/system/ 目录下的工具模板
 */

// 导出各个渲染模板
export { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
export { webFetchRender } from './web.render.js';
export { calculatorRender } from './math.render.js';

// 导入以便创建映射表
import { readFileRender, writeFileRender, listDirRender } from './fs.render.js';
import { webFetchRender } from './web.render.js';
import { calculatorRender } from './math.render.js';

/**
 * 模板 Key -> 渲染模板 映射表
 * Key 与工具定义中 render 字段的值对应
 *
 * 注意：这里只包含仍在 tools/system/ 目录下的工具模板
 * Feature 模块的模板由各自的 Feature.getTemplatePaths() 提供
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

  // 默认 fallback
  'json': {
    call: () => '<div class="bash-command">Tool call</div>',
    result: (data: any) => `<pre style="background:var(--bg-secondary); padding:8px; border-radius:4px; overflow:auto;">${JSON.stringify(data, null, 2)}</pre>`,
  },
};
