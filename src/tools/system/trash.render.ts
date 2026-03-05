/**
 * Safe Trash 工具渲染模板
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
export const trashDeleteRender: InlineRenderTemplate = {
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
};

/**
 * Trash List 渲染模板
 */
export const trashListRender: InlineRenderTemplate = {
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
              <td style="padding:4px 8px; color:var(--text-secondary);">${escapeHtml(String(f.deletion_date))}</td>
              <td style="padding:4px 8px; text-align:right; color:var(--text-secondary);">${escapeHtml(f.size_formatted || '0 B')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
  }
};

/**
 * Trash Restore 渲染模板
 */
export const trashRestoreRender: InlineRenderTemplate = {
  call: (args: any) => {
    const target = args.target !== undefined ? escapeHtml(String(args.target)) : '';
    return `<div class="bash-command">Restore <span class="pattern">${target}</span></div>`;
  },
  result: (data: any, success?: boolean) => {
    if (!success) return formatError(data);

    const restored = data.restored || [];
    const failed = data.failed || [];
    const restoredCount = restored.length;
    const failedCount = failed.length;

    if (restoredCount > 0 && failedCount === 0) {
      let html = `<div style="color:var(--success-color)">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle; margin-right:4px;">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        Restored ${restoredCount} item(s)
      </div>`;

      if (restoredCount > 0 && restoredCount <= 5) {
        html += `<div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">${restored.map((p: string) => escapeHtml(p)).join(', ')}</div>`;
      }

      return html;
    }

    if (restoredCount > 0 || failedCount > 0) {
      let html = '';

      if (restoredCount > 0) {
        html += `<div style="color:var(--success-color); margin-bottom:4px;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle; margin-right:4px;">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
          Restored ${restoredCount}
        </div>`;
      }

      if (failedCount > 0) {
        html += `<div style="color:var(--error-color); margin-bottom:4px;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle; margin-right:4px;">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          ${failedCount} failed
        </div>`;

        const errorMessages = failed.map((f: any) => {
          const path = f.path || 'unknown';
          const error = f.error || 'unknown error';
          return `${escapeHtml(path)}: ${escapeHtml(error)}`;
        }).join('; ');

        html += `<div style="font-size:11px; color:var(--error-color); margin-top:4px;">${errorMessages}</div>`;
      }

      return html || `<div style="color:var(--text-secondary)">Nothing restored</div>`;
    }

    return `<div style="color:var(--text-secondary)">Nothing restored</div>`;
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'trash-delete': trashDeleteRender,
  'trash-list': trashListRender,
  'trash-restore': trashRestoreRender,
};
