/**
 * task_get 工具渲染模板
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
    return `<div class="bash-command">获取任务详情 <span class="pattern">#${escapeHtml(args.taskId || '')}</span></div>`;
  },
  result: (data: any, success?: boolean) => {
    if (!success || data.error) {
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(data.error || '获取任务失败')}</span>
      </div>`;
    }
    let output = `<div style="padding:8px; background:var(--code-bg); border-radius:4px; font-size:12px;">`;
    output += `<div style="margin-bottom:4px;"><strong>#${data.id}</strong> ${escapeHtml(data.subject || '')}</div>`;
    output += `<div style="color:${getStatusColor(data.status)}; margin-bottom:4px;">[${getStatusText(data.status)}]</div>`;
    if (data.description) {
      output += `<div style="color:var(--text-secondary); margin-bottom:4px;">${escapeHtml(data.description)}</div>`;
    }
    if (data.blockedBy && data.blockedBy.length > 0) {
      output += `<div style="font-size:11px; color:var(--warning-color);">依赖: ${data.blockedBy.map((id: string) => '#' + id).join(', ')}</div>`;
    }
    output += `</div>`;
    return output;
  }
} as const satisfies InlineRenderTemplate;
