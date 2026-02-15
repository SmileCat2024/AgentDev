/**
 * 数学计算工具渲染模板
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
 * 数学计算渲染模板
 */
export const calculatorRender: InlineRenderTemplate = {
  call: '<div class="bash-command">{{expression}}</div>',
  result: (data) => `<div class="bash-command" style="color:#d2a8ff">= ${escapeHtml(data)}</div>`
};
