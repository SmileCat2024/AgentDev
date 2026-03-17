/**
 * Bash 工具渲染模板
 */

import type { InlineRenderTemplate } from 'agentdev';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

function formatOutput(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    if (data instanceof Error) return data.message;
    const obj = data as Record<string, unknown>;
    if ('stdout' in obj || 'stderr' in obj) {
      return String(obj.stdout || '') + String(obj.stderr || '');
    }
    if ('error' in obj) {
      const errorValue = obj.error;
      if (typeof errorValue === 'string') return errorValue;
      if (errorValue instanceof Error) return errorValue.message;
      return JSON.stringify(data, null, 2);
    }
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}

function formatError(data: unknown): string {
  const text = formatOutput(data);
  return `<div class="tool-error">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    <span>${escapeHtml(text)}</span>
  </div>`;
}

const bashRender: InlineRenderTemplate = {
  call: (args: { command?: string }) => {
    const command = args.command || '';
    return `<div class="bash-command">> ${escapeHtml(command)}</div>`;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success) return formatError(data);
    const output = formatOutput(data);
    return `<pre class="bash-output">${escapeHtml(output)}</pre>`;
  }
};

export default bashRender;
