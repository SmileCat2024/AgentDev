/**
 * Safe Trash List 渲染模板
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
 * 格式化日期时间
 */
function formatDateTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

/**
 * Trash List 渲染模板
 */
export default {
  call: (args: any) => {
    const trashDir = args.trashDir || '.trash';
    return `<div class="bash-command">List trash <span style="color:var(--text-secondary); font-size:11px;">(${escapeHtml(trashDir)})</span></div>`;
  },
  result: (data: any, success?: boolean) => {
    if (!success) return formatError(data);

    const total = data.total || 0;
    const files = data.files || [];

    if (total === 0) {
      return `<div style="color:var(--text-secondary); font-style:italic; padding:12px;">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle; margin-right:4px; opacity:0.5;">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
        Trash is empty
      </div>`;
    }

    return `<div style="font-family:monospace; font-size:12px;">
      <div style="color:var(--text-secondary); margin-bottom:8px;">${total} item(s) in trash</div>
      <table style="border-collapse:collapse; width:100%;">
        <thead>
          <tr style="color:var(--text-secondary); font-size:11px;">
            <th style="text-align:left; padding:4px 8px; border-bottom:1px solid var(--border-color);">#</th>
            <th style="text-align:left; padding:4px 8px; border-bottom:1px solid var(--border-color);">Path</th>
            <th style="text-align:left; padding:4px 8px; border-bottom:1px solid var(--border-color);">Date</th>
            <th style="text-align:right; padding:4px 8px; border-bottom:1px solid var(--border-color);">Size</th>
          </tr>
        </thead>
        <tbody>
          ${files.map((f: any) => `
            <tr style="border-bottom:1px solid var(--border-color); ${f.index % 2 === 0 ? '' : 'background:rgba(255,255,255,0.02);'}">
              <td style="padding:4px 8px; color:var(--accent-color);">${escapeHtml(String(f.index))}</td>
              <td style="padding:4px 8px; max-width:400px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(f.original_path)}">${escapeHtml(f.original_path)}</td>
              <td style="padding:4px 8px; color:var(--text-secondary);">${escapeHtml(formatDateTime(f.deletion_date))}</td>
              <td style="padding:4px 8px; text-align:right; color:var(--text-secondary);">${escapeHtml(f.size_formatted || '0 B')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  }
} as const satisfies InlineRenderTemplate;
