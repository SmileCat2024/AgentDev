/**
 * LS 工具渲染模板
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
 * LS 目录列表渲染模板
 */
export const lsRender: InlineRenderTemplate = {
  call: '<div class="bash-command">List <span class="path">{{dirPath}}</span></div>',
  result: (data) => {
    const result = data as { path?: string; count?: number; truncated?: boolean; tree?: string };

    return `<div style="font-family:monospace; font-size:11px; line-height:1.4; max-height:400px; overflow:auto; white-space:pre; color:var(--text-primary);">${escapeHtml(result.tree || '')}</div>
      <div style="color:var(--text-secondary); padding:4px 0; font-size:11px;">
        ${result.count} file${result.count !== 1 ? 's' : ''} found
        ${result.truncated ? '<span style="color:var(--warning-color)"> (truncated)</span>' : ''}
      </div>`;
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'ls': lsRender,
};
