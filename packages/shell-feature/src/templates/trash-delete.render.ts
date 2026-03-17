/**
 * Safe Trash Delete 渲染模板
 */

import type { InlineRenderTemplate } from 'agentdev';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

function formatError(data: unknown): string {
  const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  return `<div class="tool-error"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg><span>${escapeHtml(text)}</span></div>`;
}

export default {
  call: (args: { paths?: string[] }) => {
    const paths = args.paths || [];
    const displayPaths = paths.slice(0, 3).map(p => escapeHtml(p)).join(', ');
    const more = paths.length > 3 ? ` +${paths.length - 3} more` : '';
    return `<div class="bash-command">Safe delete <span class="file-path">${displayPaths}${more}</span></div>`;
  },
  result: (data: { moved_count?: number; failed?: string[] }, success?: boolean) => {
    if (!success) return formatError(data);
    const movedCount = data.moved_count || 0;
    const failed = data.failed || [];
    if (movedCount > 0 && failed.length === 0) {
      return `<div style="color:var(--success-color)"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle;margin-right:4px"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Moved ${movedCount} item(s) to trash</div>`;
    }
    if (movedCount > 0) {
      let html = `<div style="color:var(--warning-color)"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle;margin-right:4px"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>Moved ${movedCount}, ${failed.length} failed</div>`;
      if (failed.length > 0) html += `<div style="font-size:11px;color:var(--error-color);margin-top:4px">Failed: ${escapeHtml(failed.join(', '))}</div>`;
      return html;
    }
    return `<div style="color:var(--text-secondary)">No files moved</div>`;
  }
} as const satisfies InlineRenderTemplate;
