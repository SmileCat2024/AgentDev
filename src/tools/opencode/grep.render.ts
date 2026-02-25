/**
 * Grep 工具渲染模板
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
 * Grep 搜索渲染模板
 */
export const grepRender: InlineRenderTemplate = {
  call: (args) => {
    let output = `<div class="bash-command">Grep <span class="pattern">${escapeHtml(args.pattern || '')}</span></div>`;
    if (args.searchPath) {
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px;">in ${escapeHtml(args.searchPath)}</div>`;
    }
    if (args.include) {
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px;">(${escapeHtml(args.include)})</div>`;
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
    if (!data.results || data.results.length === 0) {
      return '<div style="color:var(--warning-color)">No matches found</div>';
    }
    let currentFile = '';
    const output = [];
    for (const match of data.results) {
      if (currentFile !== match.path) {
        if (currentFile !== '') {
          output.push('</div>');
        }
        currentFile = match.path;
        output.push(`<div style="margin-top:8px;">
          <div style="color:var(--accent-color); font-weight:bold; font-size:11px;">${escapeHtml(match.path)}</div>
        `);
      }
      output.push(`<div style="display:flex; gap:8px; font-family:&quot;Fira Code&quot;, &quot;Cascadia Code&quot;, &quot;Source Code Pro&quot;, &quot;JetBrains Mono&quot;, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace; font-size:11px;">
        <span style="color:var(--text-secondary); min-width:40px;">:${match.lineNum}</span>
        <span style="color:var(--text-primary);">${escapeHtml(match.lineText)}</span>
      </div>`);
    }
    if (currentFile !== '') {
      output.push('</div>');
    }
    return `<div style="max-height:400px; overflow:auto;">
      ${output.join('')}
      ${data.truncated ? '<div style="color:var(--warning-color); padding:4px 0;">(Results truncated...)</div>' : ''}
      <div style="color:var(--text-secondary); padding:4px 0;">Found ${data.matches} match${data.matches !== 1 ? 'es' : ''}</div>
    </div>`;
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'grep': grepRender,
};
