/**
 * wait 工具渲染模板
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
  call: () => {
    return `<div class="bash-command">等待子代理运行完成......</div>`;
  },
  result: (data: any) => {
    if (data.error) {
      return `<div style="color:var(--error-color)">✗ ${escapeHtml(data.error)}</div>`;
    }
    return `<div style="color:var(--info-color)">${escapeHtml(data.message || '等待子代理运行结果...')}</div>`;
  }
} as const satisfies InlineRenderTemplate;
