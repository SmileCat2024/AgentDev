/**
 * Shell 命令工具渲染模板
 */

import type { InlineRenderTemplate } from '../../core/types.js';

/**
 * HTML 转义辅助函数
 */
function escapeHtml(text: any): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Shell 命令渲染模板
 */
export const shellCommandRender: InlineRenderTemplate = {
  call: '<div class="bash-command">> {{command}}</div>',
  result: (data) => `<pre class="bash-output">${escapeHtml(data)}</pre>`
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'command': shellCommandRender,
  'bash': shellCommandRender,
  'shell': shellCommandRender,
};
