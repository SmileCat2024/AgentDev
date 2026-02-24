/**
 * Glob 工具渲染模板
 * 使用 viewer-worker.ts HTML 中的版本（函数模板，更灵活）
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
  call: (args) => {
    let output = `<div class="bash-command">Glob <span class="pattern">${escapeHtml(args.pattern || '')}</span></div>`;
    if (args.searchPath) {
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px;">in ${escapeHtml(args.searchPath)}</div>`;
    }
    return output;
  },
  result: (data, success) => {
    if (!success) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(text)}</span>
      </div>`;
    }
    if (!data.files || data.files.length === 0) {
      return '<div style="color:var(--warning-color)">No files found</div>';
    }
    return `<div style="font-family:monospace; font-size:12px; max-height:300px; overflow:auto;">
      ${data.files.map((f: string) => `<div style="color:var(--text-primary); padding:2px 0;">${escapeHtml(f)}</div>`).join('')}
      ${data.truncated ? '<div style="color:var(--warning-color); padding:4px 0;">(Results truncated...)</div>' : ''}
      <div style="color:var(--text-secondary); padding:4px 0;">Found ${data.count} file${data.count !== 1 ? 's' : ''}</div>
    </div>`;
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'glob': globRender,
};
