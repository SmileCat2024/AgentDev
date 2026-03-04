/**
 * task_create 工具渲染模板
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
 * 渲染任务列表（通用）
 */
function renderTaskList(tasks: Array<{ id: string; subject: string; status: string }>): string {
  return `<div style="font-family:"Fira Code", "Cascadia Code", "Source Code Pro", "JetBrains Mono", ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace; font-size:12px; max-height:300px; overflow:auto;">
    ${tasks.map(t => `
      <div style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid var(--border-color);">
        <span style="color:var(--text-secondary); min-width:24px;">#${t.id}</span>
        <span style="color:var(--text-primary); flex:1;">${escapeHtml(t.subject)}</span>
        <span style="color:${getStatusColor(t.status)}; font-size:11px;">${t.status}</span>
      </div>
    `).join('')}
  </div>`;
}

export default {
  call: (args: any) => {
    return `<div class="bash-command">创建任务 <span class="pattern">${escapeHtml(args.subject || '')}</span></div>`;
  },
  result: (data: any, success?: boolean) => {
    if (!success || data.error) {
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(data.error || '创建任务失败')}</span>
      </div>`;
    }
    let output = `<div style="color:var(--success-color)">✓ ${escapeHtml(data.message || '任务已创建')}</div>`;
    if (data.allTasks && data.allTasks.length > 0) {
      output += renderTaskList(data.allTasks);
    }
    return output;
  }
} as const satisfies InlineRenderTemplate;
