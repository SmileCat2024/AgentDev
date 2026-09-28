/**
 * bg_status 渲染模板 — 单个后台任务的状态与新增输出
 *
 * execute 经 withDisplay 附带结构化数据（kind='bg-status'）：头部状态行 +
 * 命令行 + 新增输出块；截断提示 / 日志路径 / 滞留通知补发以注释行呈现。
 * 未找到任务与历史会话（无 display 的纯文本）走文本回退。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

interface BgStatusDisplay {
  kind: 'bg-status';
  taskId: string;
  status: 'running' | 'done' | 'killed';
  durationMs: number;
  exitCode: number | null;
  quietMs: number;
  nextReportInMs: number | null;
  command: string;
  newOutput: string;
  outputTruncated?: boolean;
  clamped?: boolean;
  logHint?: string;
  catchUp?: string[];
}

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

function fmtDur(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export default {
  call: (args: Record<string, unknown>) => {
    const taskId = String((args || {}).taskId ?? '');
    return `<div class="bash-command">${escapeHtml(taskId)}</div>`;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data ?? '');
      return `<div class="tool-error"><span>${escapeHtml(text)}</span></div>`;
    }
    if (data && typeof data === 'object' && (data as Record<string, unknown>).kind === 'bg-status') {
      const d = data as BgStatusDisplay;
      const chip = d.status === 'running'
        ? '<span class="tool-chip ok">运行中</span>'
        : (d.status === 'killed'
          ? '<span class="tool-chip">已停止</span>'
          : (d.exitCode === 0
            ? '<span class="tool-chip">已完成</span>'
            : `<span class="tool-chip err">失败 · 退出码 ${d.exitCode ?? 'null'}</span>`));
      const metas: string[] = [`已运行 ${fmtDur(d.durationMs)}`];
      if (d.status === 'running') {
        metas.push(`安静 ${Math.round(d.quietMs / 1000)}s`);
        if (d.nextReportInMs !== null && d.nextReportInMs !== undefined) {
          metas.push(`下次汇报 ~${Math.round(d.nextReportInMs / 1000)}s`);
        }
      } else {
        metas.push(`退出码 ${d.exitCode === null ? 'null' : d.exitCode}`);
      }
      let html = `<div class="tool-bg-head">`
        + `<span class="tool-bg-id">${escapeHtml(d.taskId)}</span>`
        + chip
        + metas.map(m => `<span class="tool-bg-meta">${escapeHtml(m)}</span>`).join('')
        + `</div>`
        + `<div class="bash-command">$ ${escapeHtml(d.command)}</div>`;
      if (d.newOutput) {
        html += `<div class="tool-bg-meta">新增输出</div>`
          + `<pre class="bash-output">${escapeHtml(d.newOutput)}</pre>`;
      } else {
        html += `<div class="tool-result-note">自上次查看以来无新增输出</div>`;
      }
      if (d.outputTruncated) {
        html += `<div class="tool-result-note tool-result-warning">增量过长：中段已省略，完整内容见日志文件</div>`;
      }
      if (d.clamped) {
        html += `<div class="tool-result-note tool-result-warning">部分早期输出超出内存缓冲，完整内容在日志文件中</div>`;
      }
      if (d.logHint) {
        html += `<div class="tool-result-note">${escapeHtml(d.logHint)}</div>`;
      }
      if (d.catchUp && d.catchUp.length > 0) {
        html += `<div class="tool-bg-meta">滞留通知补发</div>`
          + `<pre class="bash-output">${escapeHtml(d.catchUp.join('\n---\n'))}</pre>`;
      }
      return html;
    }
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const warn = text.startsWith('未找到');
    return `<div class="tool-plain-text${warn ? ' warn' : ''}">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
