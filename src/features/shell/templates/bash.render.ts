/**
 * Bash 工具渲染模板（Shell Feature 内部模板）
 */

import type { InlineRenderTemplate } from '../../../core/types.js';

/**
 * HTML 转义辅助函数
 */
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

/**
 * Bash 渲染模板
 */
const bashRender: InlineRenderTemplate = {
  call: (args: { command?: string }) => {
    const command = args.command || '';
    return `<div class="bash-command">> ${escapeHtml(command)}</div>`;
  },
  result: (data: unknown) => {
    return `<pre class="bash-output">${escapeHtml(data)}</pre>`;
  }
};

export default bashRender;
