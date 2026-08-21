/**
 * agent-send 工具渲染模板
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
    return `<div class="bash-command">发送指令到 <span class="pattern">${escapeHtml(args.agentId || '')}</span></div>`;
  },
  result: (data: any) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${escapeHtml(data.error)}</div>`;
    }
    let output = `<div style="color:var(--success-color)">✓ 指令已发送</div>`;

    // 显示所有 agent 列表
    if (data.allAgents && data.allAgents.length > 0) {
      const agentsList = data.allAgents.map((a: any) => {
        const statusText = a.status === 'busy' ? '[运行中]' : a.status === 'idle' ? '[空闲]' : '[已完成]';
        return `${statusText} ${escapeHtml(a.agentId)}`;
      }).join(' · ');
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; margin-top:4px;">${agentsList}</div>`;
    }
    return output;
  }
} as const satisfies InlineRenderTemplate;
