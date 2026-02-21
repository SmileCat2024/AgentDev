/**
 * Grep 工具渲染模板
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
  call: '<div class="bash-command">Grep <span class="pattern">{{pattern}}</span>{{#if searchPath}} in <span class="path">{{searchPath}}</span>{{/if}}{{#if include}} (<span class="include">{{include}}</span>){{/if}}</div>',
  result: (data) => {
    const result = data as { pattern?: string; matches?: number; truncated?: boolean; results?: Array<{ path: string; lineNum: number; lineText: string }> };

    if (!result.results || result.results.length === 0) {
      return '<div style="color:var(--warning-color)">No matches found</div>';
    }

    let currentFile = '';
    const output: string[] = [];

    for (const match of result.results) {
      if (currentFile !== match.path) {
        if (currentFile !== '') {
          output.push('</div>');
        }
        currentFile = match.path;
        output.push(`<div style="margin-top:8px;">
          <div style="color:var(--accent-color); font-weight:bold; font-size:11px;">${escapeHtml(match.path)}</div>
        `);
      }
      output.push(`<div style="display:flex; gap:8px; font-family:monospace; font-size:11px;">
        <span style="color:var(--text-secondary); min-width:40px;">:${match.lineNum}</span>
        <span style="color:var(--text-primary);">${escapeHtml(match.lineText)}</span>
      </div>`);
    }

    if (currentFile !== '') {
      output.push('</div>');
    }

    return `<div style="max-height:400px; overflow:auto;">
      ${output.join('')}
      ${result.truncated ? '<div style="color:var(--warning-color); padding:4px 0;">(Results truncated...)</div>' : ''}
      <div style="color:var(--text-secondary); padding:4px 0;">Found ${result.matches} match${result.matches !== 1 ? 'es' : ''}</div>
    </div>`;
  }
};
