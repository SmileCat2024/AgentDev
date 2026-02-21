/**
 * Read 工具渲染模板
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
 * 文件读取渲染模板
 */
export const readRender: InlineRenderTemplate = {
  call: '<div class="bash-command">Read <span class="file-path">{{filePath}}</span>{{#if offset}} (line {{offset}}{{#if limit}}-{{offset}}+{{limit}}{{/if}}){{/if}}</div>',
  result: (data) => {
    const result = data as any;

    // 目录类型
    if (result.type === 'directory') {
      return `<div style="font-family:monospace; font-size:12px; line-height:1.6;">
        <div style="color:var(--accent-color); margin-bottom:8px;">📁 ${escapeHtml(result.path)}</div>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:4px;">
          ${result.entries.map((e: string) => {
            const isDir = e.endsWith('/') || e.endsWith('\\');
            return `<div style="color:${isDir ? 'var(--accent-color)' : 'var(--text-primary)'}; padding:2px 4px;">${escapeHtml(e)}</div>`;
          }).join('')}
        </div>
        <div style="color:var(--text-secondary); margin-top:8px; font-size:11px;">
          ${result.entries.length} of ${result.totalEntries} entries shown
          ${result.truncated ? ' (truncated)' : ''}
        </div>
      </div>`;
    }

    // 文件类型
    return `<div>
      <div style="font-family:monospace; font-size:12px; line-height:1.4; max-height:400px; overflow:auto; background:var(--bg-secondary); padding:8px; border-radius:4px;">
        ${escapeHtml(result.content || '')}
      </div>
      <div style="color:var(--text-secondary); margin-top:8px; font-size:11px;">
        ${result.path} — ${result.totalLines} lines total
        ${result.truncated
          ? result.truncatedByBytes
            ? '(truncated at 50KB)'
            : `(showing lines ${result.offset}-${result.lastReadLine}, use offset to read more)`
          : '(end of file)'
        }
      </div>
    </div>`;
  }
};
