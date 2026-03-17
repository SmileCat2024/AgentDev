/**
 * Safe Trash Restore 渲染模板
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
  call: (args: { target?: string | number }) => {
    const target = args.target !== undefined ? escapeHtml(String(args.target)) : '';
    return `<div class="bash-command">Restore <span class="pattern">${target}</span></div>`;
  },
  result: (data: { restored?: string[]; failed?: Array<{ path: string; error: string }> }, success?: boolean) => {
    if (!success) return formatError(data);
    const restored = data.restored || [];
    const failed = data.failed || [];
    if (restored.length > 0 && failed.length === 0) {
      let html = `<div style="color:var(--success-color)"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle;margin-right:4px"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Restored ${restored.length} item(s)</div>`;
      if (restored.length > 0 && restored.length <= 5) {
        html += `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px">${restored.map(p => escapeHtml(p)).join(', ')}</div>`;
      }
      return html;
    }
    if (restored.length > 0 || failed.length > 0) {
      let html = '';
      if (restored.length > 0) {
        html += `<div style="color:var(--success-color);margin-bottom:4px"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle;margin-right:4px"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Restored ${restored.length}</div>`;
      }
      if (failed.length > 0) {
        html += `<div style="color:var(--error-color);margin-bottom:4px"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="vertical-align:middle;margin-right:4px"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>${failed.length} failed</div>`;
        const errorMessages = failed.map(f => `${escapeHtml(f.path)}: ${escapeHtml(f.error)}`).join('; ');
        html += `<div style="font-size:11px;color:var(--error-color);margin-top:4px">${errorMessages}</div>`;
      }
      return html || `<div style="color:var(--text-secondary)">Nothing restored</div>`;
    }
    return `<div style="color:var(--text-secondary)">Nothing restored</div>`;
  }
} as const satisfies InlineRenderTemplate;
