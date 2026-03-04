/**
 * task_clear 工具渲染模板
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
    return `<div class="bash-command">清空所有任务</div>`;
  },
  result: (data: any, success?: boolean) => {
    if (!success || data.error) {
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(data.error || '清空任务失败')}</span>
      </div>`;
    }
    return `<div style="color:var(--success-color)">✓ ${escapeHtml(data.message || '任务列表已清空')}</div>`;
  }
} as const satisfies InlineRenderTemplate;
