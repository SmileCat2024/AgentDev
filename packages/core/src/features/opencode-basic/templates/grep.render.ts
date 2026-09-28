/**
 * Grep 工具渲染模板
 * 使用 viewer-worker.ts HTML 中的版本（函数模板，更灵活）
 */

import type { InlineRenderTemplate } from '../../../core/types.js';

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
export default {
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
        if (currentFile !== '') output.push('</div>');
        currentFile = match.path;
        output.push(`<div class="tool-search-file"><div class="tool-search-path" title="${escapeHtml(match.path)}">${escapeHtml(match.path)}</div>`);
      }
      output.push(`<div class="tool-search-line" data-line="${escapeHtml(match.lineNum)}"><span>${escapeHtml(match.lineText)}</span></div>`);
    }
    if (currentFile !== '') output.push('</div>');
    return `<div class="tool-search-results">
      ${output.join('')}
      ${data.truncated ? '<div class="tool-result-note tool-result-warning">Results truncated</div>' : ''}
      <div class="tool-result-note">Found ${data.matches} match${data.matches !== 1 ? 'es' : ''}</div>
    </div>`;
  }
} as const satisfies InlineRenderTemplate;
