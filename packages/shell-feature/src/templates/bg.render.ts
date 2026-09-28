/**
 * 后台任务小操作渲染模板 — bg_wait / bg_tune / bg_write / bg_kill 共用
 *
 * 这些工具的结果是一两句确认文本：正文用普通字体（非等宽）呈现，
 * 调用参数（任务号 + 节奏摘要）用 chips 呈现。
 * bg_write 例外：stdin 文本是调用主体，按终端输入样式（bash-command）呈现。
 * 语义色：找不到任务 / 写入失败等以 warn 色提示；失败态走 tool-error。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

/** 结果文本中的可预期失败前缀：工具以 success=true 返回、但对用户值得用警示色。 */
const WARN_PREFIXES = ['未找到', '写入失败', '未指定调整项'];

function isWarnText(text: string): boolean {
  return WARN_PREFIXES.some(p => text.startsWith(p));
}

export default {
  call: (args: Record<string, unknown>) => {
    const a = args || {};
    const taskId = String(a.taskId ?? '');
    // bg_write：往任务 stdin 写入等价于往终端敲内容，文本按 bash 调用卡的
    // 终端输入样式呈现，任务号以 chip 标注写入目标。
    if (typeof a.text === 'string' && a.text) {
      return `<div class="bash-command">&gt; ${escapeHtml(a.text)}</div>`
        + `<div class="tool-chips"><span class="tool-chip">stdin → ${escapeHtml(taskId)}</span></div>`;
    }
    const chips: string[] = [];
    if (typeof a.afterSec === 'number') chips.push(`afterSec=${a.afterSec}s`);
    if (typeof a.intervalSec === 'number') chips.push(`intervalSec=${a.intervalSec}s`);
    if (typeof a.quietAfterSec === 'number') chips.push(`quietAfterSec=${a.quietAfterSec}s`);
    const chipsHtml = chips.length > 0
      ? `<div class="tool-chips">${chips.map(c => `<span class="tool-chip">${c}</span>`).join('')}</div>`
      : '';
    return `<div class="bash-command">${escapeHtml(taskId)}</div>${chipsHtml}`;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (isWarnText(text)) {
      return `<div class="tool-plain-text warn">${escapeHtml(text)}</div>`;
    }
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
