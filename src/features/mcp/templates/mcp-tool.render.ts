/**
 * MCP 工具渲染模板
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
 * 使用 hljs 将 JSON 渲染为带行号的语法高亮
 */
function renderJsonHighlight(data: any): string {
  const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  const lines = displayData.split('\n');
  return '<div class="code-read-container">' + lines.map((line: string, i: number) => {
    let highlighted: string;
    try { highlighted = (hljs as any).highlight(line, { language: 'json' }).value; }
    catch (e) { highlighted = escapeHtml(line); }
    return '<div class="code-read-line"><span class="code-read-line-num">' + (i + 1) + '</span><span class="code-read-content">' + highlighted + '</span></div>';
  }).join('') + '</div>';
}

declare const hljs: any;

/**
 * MCP 工具调用渲染模板
 */
export default {
  call: (args: any) => {
    return `<div class="bash-command">MCP Tool Call</div>`;
  },
  result: (data: any, success?: boolean) => {
    if (!success) return formatError(data);
    if (typeof data === 'object') {
      return renderJsonHighlight(data);
    }
    return `<pre class="bash-output">${escapeHtml(String(data))}</pre>`;
  }
} as const satisfies InlineRenderTemplate;
