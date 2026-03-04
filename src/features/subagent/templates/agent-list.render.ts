/**
 * agent-list 工具渲染模板
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
  call: '<div class="bash-command">List agents (filter: {{filter}})</div>',
  result: (data: any) => {
    if (!data.agents || data.agents.length === 0) {
      return `<div style="color:var(--warning-color)">No agents found</div>`;
    }
    return `<div style="font-size:12px;">
      <div>Total: ${data.total} | Running: ${data.running}</div>
      ${data.agents.map((a: any) => `
        <div style="margin-top:4px; padding:4px; background:var(--code-bg); border-radius:4px;">
          <strong>${a.agentId}</strong> (${a.type}) - <span style="color:${a.status === 'idle' || a.status === 'busy' ? 'var(--success-color)' : 'var(--warning-color)'}">${a.status}</span>
        </div>
      `).join('')}
    </div>`;
  }
} as const satisfies InlineRenderTemplate;
