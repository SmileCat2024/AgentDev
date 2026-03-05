/**
 * Safe Trash Delete 渲染模板
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
 * 格式化错误
 */
function formatError(data: any): string {
  const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  return `<div class="tool-error">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    <span>${escapeHtml(text)}</span>
  </div>`;
}

/**
 * Trash Delete 渲染模板
 */
export default {
  call: (args: any) => {
    const paths = args.paths || [];
    const pathList = Array.isArray(paths) ? paths : [paths];
    const displayPaths = pathList.slice(0, 3).map((p: string) => escapeHtml(p)).join(', ');
    const more = pathList.length > 3 ? ` +${pathList.length - 3} more` : '';
    return `<div class="bash-command">Safe delete <span class="file-path">${displayPaths}${more}</span></div>`;
  },
  result: (data: any, success?: boolean) => {
    if (!success) return formatError(data);

    const movedCount = data.moved_count || 0;
    const failed = data.failed || [];
    const failedCount = failed.length;

    if (movedCount > 0 && failedCount === 0) {
      return `<div style="color:var(--success-color)">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle; margin-right:4px;">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        Moved ${movedCount} item(s) to trash
      </div>`;
    }

    if (movedCount > 0) {
      let html = `<div style="color:var(--warning-color)">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle; margin-right:4px;">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
        Moved ${movedCount}, ${failedCount} failed
      </div>`;
      if (failed.length > 0) {
        html += `<div style="font-size:11px; color:var(--error-color); margin-top:4px;">Failed: ${escapeHtml(failed.join(', '))}</div>`;
      }
      return html;
    }

    return `<div style="color:var(--text-secondary)">No files moved</div>`;
  }
} as const satisfies InlineRenderTemplate;
