import type { InlineRenderTemplate } from '../../../core/types.js';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

export default {
  call: (_args: Record<string, unknown>) => {
    return `<div class="web-fetch-call">crawl4ai MCP call</div>`;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success) {
      return `<div class="tool-error">${escapeHtml(data)}</div>`;
    }

    const content = typeof data === 'object'
      ? JSON.stringify(data, null, 2)
      : String(data ?? '');

    return `<pre style="background:var(--bg-secondary); padding:8px; border-radius:4px; overflow:auto; max-height:300px;">${escapeHtml(content)}</pre>`;
  },
} as const satisfies InlineRenderTemplate;
