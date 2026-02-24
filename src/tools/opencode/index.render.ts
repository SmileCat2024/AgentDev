/**
 * Opencode 工具渲染模板统一导出
 * 供前端 viewer-worker-frontend.ts 直接 import 使用
 */

// 导出各个渲染模板
export { globRender } from './glob.render.js';
export { grepRender } from './grep.render.js';
export { lsRender } from './ls.render.js';
export { readRender } from './read.render.js';
export { editRender } from './edit.render.js';
export { writeRender } from './write.render.js';

// 导入以便创建映射表
import { globRender } from './glob.render.js';
import { grepRender } from './grep.render.js';
import { lsRender } from './ls.render.js';
import { readRender } from './read.render.js';
import { editRender } from './edit.render.js';
import { writeRender } from './write.render.js';

/**
 * 模板 Key -> 渲染模板 映射表
 * Key 与工具定义中 render 字段的值对应
 */
export const TEMPLATES: Record<string, any> = {
  'glob': globRender,
  'grep': grepRender,
  'ls': lsRender,
  'read': readRender,
  'write': writeRender,
  'edit': editRender,
};
