/**
 * bg_list 渲染模板 — 后台任务全景
 *
 * execute 对非空列表经 withDisplay 附带结构化数据（kind='bg-list'），
 * 模板渲染任务行；空列表与历史会话（无 display 的纯文本）走文本回退。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

interface BgTaskRow {
  id: string;
  status: 'running' | 'done' | 'killed';
  command: string;
  durationMs: number;
  quietMs: number;
  exitCode: number | null;
  intervalSec: number;
  quietAfterSec: number;
  inheritedPace?: boolean;
  nextReportInMs: number | null;
}

interface BgListDisplay {
  kind: 'bg-list';
  running: number;
  total: number;
  tasks: BgTaskRow[];
}

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

/** 紧凑时长：12s / 2m05s / 1h02m */
function fmtDur(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function statusChip(t: BgTaskRow): string {
  if (t.status === 'running') return '<span class="tool-chip ok">运行中</span>';
  if (t.status === 'killed') return '<span class="tool-chip">已停止</span>';
  return t.exitCode === 0
    ? '<span class="tool-chip">已完成</span>'
    : `<span class="tool-chip err">退出码 ${t.exitCode ?? 'null'}</span>`;
}

function renderRow(t: BgTaskRow): string {
  const metas: string[] = [`已运行 ${fmtDur(t.durationMs)}`];
  if (t.status === 'running') {
    metas.push(`安静 ${Math.round(t.quietMs / 1000)}s`);
    if (t.nextReportInMs !== null && t.nextReportInMs !== undefined) {
      metas.push(`下次 ~${Math.round(t.nextReportInMs / 1000)}s`);
    }
  } else {
    metas.push(`退出码 ${t.exitCode === null ? 'null' : t.exitCode}`);
  }
  const pace = `每 ${t.intervalSec}s 汇报`
    + (t.inheritedPace ? '（前台转入的紧凑值，可 bg_tune 放宽）' : '');
  return `<div class="tool-bg-row">`
    + `<div class="tool-bg-row-head">`
    + `<span class="tool-bg-id">${escapeHtml(t.id)}</span>`
    + statusChip(t)
    + metas.map(m => `<span class="tool-bg-meta">${escapeHtml(m)}</span>`).join('')
    + `</div>`
    + `<div class="bash-command">$ ${escapeHtml(t.command)}</div>`
    + `<div class="tool-bg-meta">${escapeHtml(pace)}</div>`
    + `</div>`;
}

export default {
  call: () => `<div class="bash-command">后台任务全景</div>`,
  result: (data: unknown, success?: boolean) => {
    if (!success) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    if (data && typeof data === 'object' && (data as Record<string, unknown>).kind === 'bg-list') {
      const d = data as BgListDisplay;
      return `<div class="tool-bg-tasks">${d.tasks.map(renderRow).join('')}</div>`
        + `<div class="tool-result-note">${d.running} 运行中 / ${d.total} 总计</div>`;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
