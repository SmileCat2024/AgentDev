/**
 * task_update 工具渲染模板
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
 * 状态颜色映射
 */
function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    pending: 'var(--warning-color)',
    in_progress: 'var(--info-color)',
    completed: 'var(--success-color)',
    deleted: 'var(--text-secondary)',
  };
  return colors[status] || 'var(--text-secondary)';
}

/**
 * 状态文本映射
 */
function getStatusText(status: string): string {
  const texts: Record<string, string> = {
    pending: '待执行',
    in_progress: '进行中',
    completed: '已完成',
    deleted: '已删除',
  };
  return texts[status] || status;
}

export default {
  call: (args: any) => {
    let output = `<div class="bash-command">更新任务 <span class="pattern">#${escapeHtml(args.taskId || '')}</span>`;
    if (args.status) {
      output += ` → <span style="color:${getStatusColor(args.status)}">${getStatusText(args.status)}</span>`;
    }
    output += `</div>`;
    return output;
  },
  result: (data: any, success?: boolean) => {
    if (!success || data.error) {
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(data.error || '更新任务失败')}</span>
      </div>`;
    }
    if (data.status === 'deleted') {
      return `<div style="color:var(--success-color)">✓ ${escapeHtml(data.message || '任务已删除')}</div>`;
    }
    return `<div style="color:var(--success-color)">✓ ${escapeHtml(data.message || '任务已更新')}</div>`;
  }
} as const satisfies InlineRenderTemplate;
