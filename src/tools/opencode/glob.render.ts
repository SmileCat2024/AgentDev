/**
 * Glob 工具渲染模板
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
 * Glob 搜索渲染模板
 */
export const globRender: InlineRenderTemplate = {
  call: '<div class="bash-command">Glob <span class="pattern">{{pattern}}</span>{{#if searchPath}} in <span class="path">{{searchPath}}</span>{{/if}}</div>',
  result: (data) => {
    const result = data as { count?: number; truncated?: boolean; files?: string[] };
    if (!result.files || result.files.length === 0) {
      return '<div style="color:var(--warning-color)">No files found</div>';
    }

    return `<div style="font-family:monospace; font-size:12px; max-height:300px; overflow:auto;">
      ${result.files.map(f => `<div style="color:var(--text-primary); padding:2px 0;">${escapeHtml(f)}</div>`).join('')}
      ${result.truncated ? '<div style="color:var(--warning-color); padding:4px 0;">(Results truncated...)</div>' : ''}
      <div style="color:var(--text-secondary); padding:4px 0;">Found ${result.count} file${result.count !== 1 ? 's' : ''}</div>
    </div>`;
  }
};
