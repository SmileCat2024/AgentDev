/**
 * Todo 工具渲染模板
 */

import type { InlineRenderTemplate } from '../../core/types.js';

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

/**
 * task_create - 创建任务
 */
export const taskCreateRender: InlineRenderTemplate = {
  call: (args) => {
    return `<div class="bash-command">创建任务 <span class="pattern">${escapeHtml(args.subject || '')}</span></div>`;
  },
  result: (data, success) => {
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
};

/**
 * task_list - 列出任务
 */
export const taskListRender: InlineRenderTemplate = {
  call: (args) => {
    const filter = args.status === 'all' ? '' : ` (筛选: ${escapeHtml(args.status || '')})`;
    return `<div class="bash-command">列出任务${filter}</div>`;
  },
  result: (data, success) => {
    if (!success || data.error) {
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(data.error || '获取任务列表失败')}</span>
      </div>`;
    }
    if (!data.tasks || data.tasks.length === 0) {
      return '<div style="color:var(--text-secondary)">暂无任务</div>';
    }
    let output = '';
    if (data.summary) {
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-bottom:4px;">`;
      output += `总计: ${data.summary.total} | 待执行: ${data.summary.pending} | 进行中: ${data.summary.inProgress} | 已完成: ${data.summary.completed}`;
      output += `</div>`;
    }
    output += renderTaskList(data.tasks);
    return output;
  }
};

/**
 * task_get - 获取任务详情
 */
export const taskGetRender: InlineRenderTemplate = {
  call: (args) => {
    return `<div class="bash-command">获取任务详情 <span class="pattern">#${escapeHtml(args.taskId || '')}</span></div>`;
  },
  result: (data, success) => {
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
};

/**
 * task_update - 更新任务
 */
export const taskUpdateRender: InlineRenderTemplate = {
  call: (args) => {
    let output = `<div class="bash-command">更新任务 <span class="pattern">#${escapeHtml(args.taskId || '')}</span>`;
    if (args.status) {
      output += ` → <span style="color:${getStatusColor(args.status)}">${getStatusText(args.status)}</span>`;
    }
    output += `</div>`;
    return output;
  },
  result: (data, success) => {
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
};

/**
 * task_clear - 清空任务
 */
export const taskClearRender: InlineRenderTemplate = {
  call: () => {
    return `<div class="bash-command">清空所有任务</div>`;
  },
  result: (data, success) => {
    if (!success || data.error) {
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(data.error || '清空任务失败')}</span>
      </div>`;
    }
    return `<div style="color:var(--success-color)">✓ ${escapeHtml(data.message || '任务列表已清空')}</div>`;
  }
};

/**
 * 渲染任务列表（通用）
 */
function renderTaskList(tasks: Array<{ id: string; subject: string; status: string }>): string {
  return `<div style="font-family:"Fira Code", "Cascadia Code", "Source Code Pro", "JetBrains Mono", ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace; font-size:12px; max-height:300px; overflow:auto;">
    ${tasks.map(t => `
      <div style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid var(--border-color);">
        <span style="color:var(--text-secondary); min-width:24px;">#${t.id}</span>
        <span style="color:var(--text-primary); flex:1;">${escapeHtml(t.subject)}</span>
        <span style="color:${getStatusColor(t.status)}; font-size:11px;">${getStatusText(t.status)}</span>
      </div>
    `).join('')}
  </div>`;
}

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'task-create': taskCreateRender,
  'task-list': taskListRender,
  'task-get': taskGetRender,
  'task-update': taskUpdateRender,
  'task-clear': taskClearRender,
};
