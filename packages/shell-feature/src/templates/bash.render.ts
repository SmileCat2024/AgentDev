/**
 * Bash 工具渲染模板
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

function formatOutput(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    if (data instanceof Error) return data.message;
    const obj = data as Record<string, unknown>;
    if ('stdout' in obj || 'stderr' in obj) {
      return String(obj.stdout || '') + String(obj.stderr || '');
    }
    if ('error' in obj) {
      const errorValue = obj.error;
      if (typeof errorValue === 'string') return errorValue;
      if (errorValue instanceof Error) return errorValue.message;
      return JSON.stringify(data, null, 2);
    }
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}

function formatError(data: unknown): string {
  const text = formatOutput(data);
  return `<div class="tool-error">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    <span>${escapeHtml(text)}</span>
  </div>`;
}

/**
 * 执行中进度数据（工单 025）：宿主经 call 模板第三参注入。
 * 缺省时不渲染任何进度节点，call 态与既有行为一致（降级安全）。
 */
export interface BashCallProgressContext {
  /** 工具开始执行的 Unix 毫秒时间戳 */
  startedAt?: number;
  /** 已执行时长（毫秒）；缺省时由 startedAt 插值 */
  elapsedMs?: number;
  /** 本次调用生效超时（毫秒）；null/undefined 不显示超时上限 */
  timeoutMs?: number | null;
  /** 输出尾部文本（宿主截尾，建议 5 行） */
  outputTail?: string;
}

/**
 * 后台任务启动 display 载荷：bash_bg 启动成功 / bash 超前台预算转后台时，
 * execute 经 withDisplay 附带（LLM 文本通道不变，前端渲染任务卡）。
 */
export interface BgStartedDisplay {
  kind: 'bg-started';
  taskId: string;
  command: string;
  intervalSec: number;
  quietAfterSec: number;
  readyPattern?: string;
  inherited?: boolean;
}

function isBgStartedDisplay(data: unknown): data is BgStartedDisplay {
  return !!data && typeof data === 'object'
    && (data as Record<string, unknown>).kind === 'bg-started';
}

function chip(label: string): string {
  return `<span class="tool-chip">${label}</span>`;
}

/** 后台任务启动卡：任务号 + 命令 + 汇报节奏（不包卡片，宿主提供卡面）。 */
function renderBgStarted(d: BgStartedDisplay): string {
  const chips = [
    chip(`每 ${d.intervalSec}s 汇报`),
    ...(d.readyPattern ? [chip(`就绪标记 &quot;${escapeHtml(d.readyPattern)}&quot;`)] : []),
    ...(d.inherited ? [chip('继承紧凑节奏，可 bg_tune 放宽')] : []),
  ].join('');
  return `<div class="tool-bg-head">`
    + `<span class="tool-bg-id">${escapeHtml(d.taskId)}</span>`
    + `<span class="tool-chip ok">后台任务已启动</span>`
    + `</div>`
    + `<div class="bash-command">$ ${escapeHtml(d.command)}</div>`
    + `<div class="tool-chips">${chips}</div>`;
}

function isZhUi(): boolean {
  try {
    return String(navigator.language || '').toLowerCase().startsWith('zh');
  } catch {
    return true;
  }
}

/** 紧凑时长：12s / 2m05s / 1h02m */
function formatDurationCompact(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** 超时上限展示：90s / 2m / 1.5m */
function formatTimeoutCompact(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

/**
 * 渲染执行中进度块：「已运行 Ns · 超时 Xm」+ 尾部输出预览
 * （等宽小字、限 5 行高、overflow 隐藏、直接可见不折叠）。
 * 结果落地后宿主移除该块，完成态不保留 tail。
 */
export function renderCallProgress(progress: BashCallProgressContext): string {
  const elapsedMs = typeof progress.elapsedMs === 'number' && progress.elapsedMs >= 0
    ? progress.elapsedMs
    : (typeof progress.startedAt === 'number' && progress.startedAt > 0
      ? Math.max(0, Date.now() - progress.startedAt)
      : null);
  const timeoutMs = typeof progress.timeoutMs === 'number' && progress.timeoutMs > 0
    ? progress.timeoutMs
    : null;

  const zh = isZhUi();
  const parts: string[] = [];
  if (elapsedMs !== null) {
    parts.push(zh ? `已运行 ${formatDurationCompact(elapsedMs)}` : `running ${formatDurationCompact(elapsedMs)}`);
  }
  if (timeoutMs !== null) {
    parts.push(zh ? `超时 ${formatTimeoutCompact(timeoutMs)}` : `timeout ${formatTimeoutCompact(timeoutMs)}`);
  }

  let html = '<div class="bash-progress-live">';
  if (parts.length > 0) {
    html += `<div class="bash-progress-meta"><span class="bash-progress-dot"></span>${escapeHtml(parts.join(' · '))}</div>`;
  }
  const tail = typeof progress.outputTail === 'string' ? progress.outputTail.replace(/\s+$/, '') : '';
  if (tail) {
    html += `<pre class="bash-progress-tail">${escapeHtml(tail)}</pre>`;
  }
  html += '</div>';
  return html;
}

const bashRender: InlineRenderTemplate = {
  call: (args: { command?: string; intervalSec?: number; quietAfterSec?: number; readyPattern?: string; timeout?: number }, _success?: boolean, progress?: BashCallProgressContext) => {
    const command = args?.command || '';
    const progressHtml = progress && typeof progress === 'object' ? renderCallProgress(progress) : '';
    // bash_bg / powershell 的可选节奏与超时参数：有传入才显示，bash 前台调用零变化。
    const chips: string[] = [];
    if (typeof args?.intervalSec === 'number') chips.push(`每 ${args.intervalSec}s 汇报`);
    if (typeof args?.quietAfterSec === 'number') chips.push(`静默 ${args.quietAfterSec}s 提醒`);
    if (args?.readyPattern) chips.push(`就绪标记 &quot;${escapeHtml(args.readyPattern)}&quot;`);
    if (typeof args?.timeout === 'number' && args.timeout > 0) chips.push(`超时 ${formatTimeoutCompact(args.timeout)}`);
    const chipsHtml = chips.length > 0 ? `<div class="tool-chips">${chips.map(chip).join('')}</div>` : '';
    return `<div class="bash-command">> ${escapeHtml(command)}</div>${chipsHtml}${progressHtml}`;
  },
  result: (data: unknown, success?: boolean) => {
    if (!success) return formatError(data);
    if (isBgStartedDisplay(data)) return renderBgStarted(data);
    const output = formatOutput(data);
    return `<pre class="bash-output">${escapeHtml(output)}</pre>`;
  }
};

export default bashRender;
