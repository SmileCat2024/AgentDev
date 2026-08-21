/**
 * agent-close 工具渲染模板
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

export default {
  call: (args: any) => {
    return `<div class="bash-command">Close <span class="pattern">${escapeHtml(args.agentId || '')}</span> (reason: ${args.reason || 'manual'})</div>`;
  },
  result: (data: any) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${escapeHtml(data.error)}</div>`;
    }
    return `<div style="color:var(--success-color)">✓ ${data.message || 'Agent closed'}</div>`;
  }
} as const satisfies InlineRenderTemplate;
