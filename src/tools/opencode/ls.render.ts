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
  call: (args) => `<div class="bash-command">List <span class="path">${escapeHtml(args.dirPath || '.')}</span></div>`,
  result: (data, success) => {
    if (!success) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(text)}</span>
      </div>`;
    }

    return `<div style="font-family:&quot;Fira Code&quot;, &quot;Cascadia Code&quot;, &quot;Source Code Pro&quot;, &quot;JetBrains Mono&quot;, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace; font-size:11px; line-height:1.4; max-height:400px; overflow:auto; white-space:pre; color:var(--text-primary);">${escapeHtml(data.tree || '')}</div>
      <div style="color:var(--text-secondary); padding:4px 0; font-size:11px;">
        ${data.count} file${data.count !== 1 ? 's' : ''} found
        ${data.truncated ? '<span style="color:var(--warning-color)"> (truncated)</span>' : ''}
      </div>`;
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'ls': lsRender,
};
