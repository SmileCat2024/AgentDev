/**
 * 后台 Bash 工具族 — bash_bg / bg_list / bg_status / bg_watch / bg_tune / bg_write / bg_kill
 *
 * 工具面契约（与 .agentdev/prompts/tool-bash-bg.md 一致；description 兜底内联
 * 完整教学文案——resourceRoot 缺省环境下 prompts 文件读不到，防轮询协议声明
 * 不能依赖文件存在）：
 * - bash_bg 启动观察 2s：窗口内退出直接带回结果（预判错了，白捡前台体验）；
 * - 节奏参数单位为秒，模型侧声明 clamp（interval ≥ 60s / quietAfter ≥ 30s）；
 * - 不提供主动等待原语：等待 = 结束回合，由任务自身的汇报/静默/终态通知
 *   唤醒。bg_tune 的 then="standby" 是唯一显式的"调完即待命"出口（向任务
 *   归属的 BackgroundAccess 登记一次性待命请求即返回，本回合由 StepFinish
 *   guard 消费后结束；bg_watch 的"订阅即停"同走该通道——旧订阅不误停
 *   后续轮次）；
 * - bg_watch 关键词监控订阅（一次性，≤ 20 字符）：只匹配订阅之后的新输出，
 *   命中即通知；节拍汇报不消耗它；
 * - 观察与进程干预分面：bg_tune 调汇报节奏（统一 clamp，转后台任务的 20s
 *   继承节奏因此只能调宽）、bg_write 写 stdin、bg_kill 停止。
 */

import type { Tool } from '@agentdevjs/core';
import { createTool, withDisplay, withRewrite } from '@agentdevjs/core';
import type { BackgroundAccess } from '@agentdevjs/core';
import type { BgRegistry, BgSpawnOptions } from './bg-core.js';
import {
  BG_CAPTURE_WINDOW_MS,
  BG_STATUS_MAX_CHARS,
  cleanBashStderr,
  fmtDur,
  formatForegroundOutput,
  spawnBackgroundProcess,
} from './bg-core.js';
import { rewriteWindowsNullRedirect } from './shellQuoting.js';
import { makeKillChild } from './shell-core.js';

export interface BgToolOptions extends BgSpawnOptions {
  registry: BgRegistry;
  /** 任务归属接入实例（登记 / 待命意图 / 通知衔接的事实源，见 BgRegisterOptions）。 */
  access: BackgroundAccess;
}

// ---------------------------------------------------------------------------
// 内联兜底描述（prompts 文件缺失时的完整教学文案）
// ---------------------------------------------------------------------------

export const BASH_BG_INLINE_DESCRIPTION = `在后台启动一条 bash 命令，适合构建、测试、训练、批量数据处理等长时间运行或无需立即等待结果的任务。短任务或需要立即获取结果的命令请使用前台 bash。

参数说明：
- command：要执行的 bash 命令
- intervalSec（可选，默认 90）：任务运行期间两条进度汇报之间的最大间隔（秒）。最小 60，小于按 60 计
- quietAfterSec（可选，默认 60）：任务连续无输出达到该秒数后发送静默提醒。最小 30，小于按 30 计
- readyPattern（可选）：输出中出现该文字时立即发送一次"已就绪"通知，适用于 dev server

任务运行期间会自动汇报：进度按节奏送达并附新增输出；长时间无输出会收到静默提醒（往往意味着任务停滞，需判断处置）；任务结束时完整结果立即送达。因此启动后可继续处理其他工作，或直接结束当前回合等待汇报，无需主动等待。

较长任务建议放宽节奏：构建 / 测试类可设 intervalSec=300, quietAfterSec=30（有输出说明在推进，突然安静往往意味着卡住）；dev server 类可设 intervalSec=600, quietAfterSec=600（安静属正常状态），并配合 readyPattern（如 "listening on"）。

建议长任务的命令周期性输出一行进度（处理序号、百分比或预计剩余时间），使每条汇报都能反映任务在正常推进还是已经停滞。不要在命令中用 sleep 实现延时或定时。`;

const BG_LIST_INLINE_DESCRIPTION = '列出全部后台任务的全景：任务号、命令、状态、运行时长、安静时长、当前汇报间隔、下次汇报倒计时。收到任何后台任务消息后，可用它掌握全局。';

const BG_STATUS_INLINE_DESCRIPTION = '查看一个后台任务的当前状态，并取回自上次查看以来的新增输出（超长增量只显示首尾，完整内容按提示的日志路径用 read 工具读取）。尚未送达的通知会随本次查看一并返回。适用于诊断性查看；例行跟踪依靠自动汇报即可，无需反复调用。';

const BG_WATCH_INLINE_DESCRIPTION = '订阅一次关键词监控（≤ 20 字符）：只匹配订阅之后的新输出，出现该关键词时立即收到一条通知（含当时的新增输出）。一次性订阅——命中即消耗，要继续盯同一关键词就再订阅一次；重复订阅覆盖旧关键词。调用后本回合随即结束，由通知唤醒：关键词命中、任务的自动汇报或任务结束都会唤醒你。查看历史输出用 bg_status；需要更密的例行信息用 bg_tune 调整汇报节奏。对已结束的任务调用会直接返回终态。';

const BG_TUNE_INLINE_DESCRIPTION = `调整一个后台任务的自动汇报节奏，立即生效并重新计时：intervalSec = 两条运行汇报之间的最大间隔（秒，最小 60）；quietAfterSec = 连续静默多少秒后开始提醒（秒，最小 30）。任务比预期跑得久、汇报过于频繁时放宽（如构建类任务 intervalSec=300）；需要更密的信息流时收紧。调整一次长期生效，无需重复调用。

then="standby"（可选）：调整后立即结束当前回合、进入待命，后续由任务的进度汇报、静默提醒或完成通知自动唤醒。适用于调整完成后暂无其他工作、只等任务结果的场合。`;

const BG_WRITE_INLINE_DESCRIPTION = '向一个运行中的后台任务写入 stdin（如回答安装程序的 y/n 确认）。文本通常以 \\n 结尾；任务不在运行或 stdin 不可用时返回写入失败。';

const BG_KILL_INLINE_DESCRIPTION = '停止一个后台任务：先温和终止（允许收尾），2 秒未退出强杀进程树。任务已结束时返回当前终态和尾部输出。';

// ---------------------------------------------------------------------------
// bash_bg
// ---------------------------------------------------------------------------

/** 终态的人话标签：killed → 已停止；done 按退出码分流（null 不直接示人）。 */
function terminalLabel(status: string, exitCode: number | null): string {
  if (status === 'killed') return '已停止';
  if (exitCode === 0) return '已完成';
  return `失败，退出码 ${exitCode ?? '未知'}`;
}

export function createBashBgTool(description: string, opts: BgToolOptions): Tool {
  const { registry } = opts;
  return createTool({
    name: 'bash_bg',
    description,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令' },
        intervalSec: { type: 'number', description: '可选，默认 90 秒。两次汇报之间的最大间隔，最小 60' },
        quietAfterSec: { type: 'number', description: '可选，默认 60 秒。无输出持续此值后开始推送无新输出提醒，最小 30' },
        readyPattern: { type: 'string', description: '可选：输出匹配该文字时发一次性"已就绪"消息（dev server 类用）' },
      },
      required: ['command'],
    },
    render: { call: 'bash', result: 'bash' },
    // 2s 捕获窗 + spawn/格式化开销的余量；超时兜底（正常路径远快于此）
    timeout: { defaultMs: 15_000, maxMs: 15_000 },
    // ADR-0023：CMD 风格 >nul 重写为 >/dev/null 时，历史记录生效命令
    rewritable: true,
    execute: async (args, context) => {
      const { command, intervalSec = 90, quietAfterSec = 60, readyPattern } = args as {
        command: string; intervalSec?: number; quietAfterSec?: number; readyPattern?: string;
      };
      if (!Number.isFinite(intervalSec) || !Number.isFinite(quietAfterSec)) {
        throw new Error(`intervalSec 与 quietAfterSec 必须是数字（收到 intervalSec=${String(intervalSec)}, quietAfterSec=${String(quietAfterSec)}）`);
      }
      // CMD 风格 >nul 重写为 >/dev/null（与 bash 前台工具同规则）；重写发生时
      // 记录生效命令（ADR-0023）
      const runCommand = rewriteWindowsNullRedirect(command);
      const effectiveCall = runCommand !== command && typeof context?.callId === 'string'
        ? { id: context.callId, name: 'bash_bg', arguments: { ...args as Record<string, unknown>, command: runCommand } }
        : undefined;
      console.log(`[shell-bg] ${runCommand}`);
      const child = spawnBackgroundProcess(runCommand, opts);
      let preStdout = '';
      let preStderr = '';
      const captured = await new Promise<{ closed: true; code: number } | { closed: false }>((resolve) => {
        let settled = false;
        const onOut = (d: Buffer | string) => { preStdout += d.toString(); };
        const onErr = (d: Buffer | string) => { preStderr += d.toString(); };
        const finish = (r: { closed: true; code: number } | { closed: false }) => {
          if (settled) return;
          settled = true;
          child.stdout?.removeListener('data', onOut);
          child.stderr?.removeListener('data', onErr);
          resolve(r);
        };
        const timer = setTimeout(() => finish({ closed: false }), BG_CAPTURE_WINDOW_MS);
        timer.unref?.();
        child.stdout?.on('data', onOut);
        child.stderr?.on('data', onErr);
        child.on('error', () => { finish({ closed: true, code: -1 }); });
        child.on('close', (code) => { finish({ closed: true, code: code ?? -1 }); });
      });

      if (captured.closed) {
        // 预判错了：快速完成/快速失败，直接带回完整结果（等价前台体验）。
        const formatted = await formatForegroundOutput(
          captured.code,
          preStdout,
          cleanBashStderr(preStderr),
          opts.workdir,
        );
        if (!formatted.ok) {
          throw new Error(`命令在捕获窗内失败，退出码 ${captured.code}${formatted.text ? `\n${formatted.text}` : ''}`);
        }
        const quickText = `命令在捕获窗内已完成，退出码 ${captured.code}（你可能不需要后台模式）：\n${formatted.text}`;
        return effectiveCall ? withRewrite(quickText, effectiveCall) : quickText;
      }

      let task;
      try {
        task = registry.register(child, {
          command: runCommand,
          workdir: opts.workdir,
          access: opts.access,
          intervalMs: Math.round(intervalSec * 1000),
          quietAfterMs: Math.round(quietAfterSec * 1000),
          ...(readyPattern ? { readyPattern } : {}),
          preOutput: [preStdout, cleanBashStderr(preStderr)].filter(Boolean).join('\n'),
        });
      } catch (err) {
        // register 拒绝（如配额满）时刚 spawn 的进程无人持有：父进程握着三根
        // pipe 不放，子进程写满缓冲后永久挂起——必须 kill 再抛。
        try { makeKillChild(child)(); } catch { /* 已退出 */ }
        throw err;
      }
      const s = registry.snapshot(task);
      // LLM 文本通道（教学契约）与 display 通道（前端任务卡）分离：
      // 文本一字不动，结构化数据仅供渲染模板消费。
      const startedText = [
          `后台任务已启动：${task.id}（已运行 ${fmtDur(s.durationMs)}）`,
          `命令: ${runCommand}`,
          `汇报：每 ${Math.round(task.pace.intervalMs / 1000)}s 一条进度汇报；连续 ${Math.round(task.pace.quietAfterMs / 1000)}s 无输出时发送静默提醒${task.readyPattern ? '；输出匹配即报"已就绪"' : ''}`,
          '任务结束时完整结果会立即送达。期间可继续处理其他工作，或直接结束当前回合——汇报与结果将自动送达。',
          '查看详情用 bg_status；调整汇报节奏用 bg_tune；向任务输入用 bg_write；停止任务用 bg_kill。',
        ].join('\n');
      const startedDisplay = {
          kind: 'bg-started',
          taskId: task.id,
          command: runCommand,
          intervalSec: Math.round(task.pace.intervalMs / 1000),
          quietAfterSec: Math.round(task.pace.quietAfterMs / 1000),
          ...(readyPattern ? { readyPattern } : {}),
        };
      return effectiveCall
        ? withRewrite(startedText, effectiveCall, startedDisplay)
        : withDisplay(startedText, startedDisplay);
    },
  });
}

// ---------------------------------------------------------------------------
// bg_list / bg_status / bg_watch / bg_tune / bg_write / bg_kill
// ---------------------------------------------------------------------------

export function createBgListTool(registry: BgRegistry): Tool {
  return createTool({
    name: 'bg_list',
    description: BG_LIST_INLINE_DESCRIPTION,
    parameters: { type: 'object', properties: {} },
    render: { call: 'bg-list', result: 'bg-list' },
    execute: async () => {
      const list = registry.list();
      if (list.length === 0) return '当前没有后台任务。';
      const lines = list.map((t) => {
        const parts = [
          `${t.id} [${t.status}]`,
          `已运行 ${fmtDur(t.durationMs)}`,
          t.status === 'running' ? `安静 ${Math.round(t.quietMs / 1000)}s` : `退出码 ${t.exitCode === null ? 'null' : t.exitCode}`,
          `每 ${Math.round(t.pace.intervalMs / 1000)}s 汇报 / 静默 ${Math.round(t.pace.quietAfterMs / 1000)}s 起提醒${t.inheritedPace ? '（前台转入的紧凑值，可 bg_tune 放宽）' : ''}`,
          t.nextReportInMs !== null ? `下次汇报 ~${Math.round(t.nextReportInMs / 1000)}s` : '',
        ].filter(Boolean);
        return `${parts.join(' · ')}\n  命令: ${t.command}`;
      });
      return withDisplay(
        `后台任务全景（${list.filter((t) => t.status === 'running').length} 运行中 / ${list.length} 总计）：\n${lines.join('\n')}`,
        {
          kind: 'bg-list',
          running: list.filter((t) => t.status === 'running').length,
          total: list.length,
          tasks: list.map((t) => ({
            id: t.id,
            status: t.status,
            command: t.command,
            durationMs: t.durationMs,
            quietMs: t.quietMs,
            exitCode: t.exitCode,
            intervalSec: Math.round(t.pace.intervalMs / 1000),
            quietAfterSec: Math.round(t.pace.quietAfterMs / 1000),
            inheritedPace: !!t.inheritedPace,
            nextReportInMs: t.nextReportInMs,
          })),
        },
      );
    },
  });
}

export function createBgStatusTool(registry: BgRegistry): Tool {
  return createTool({
    name: 'bg_status',
    description: BG_STATUS_INLINE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '任务号，如 bg-1' } },
      required: ['taskId'],
    },
    render: { call: 'bg-status', result: 'bg-status' },
    execute: async (args) => {
      const { taskId } = args as { taskId: string };
      const task = registry.get(taskId);
      if (!task) return `未找到后台任务 ${taskId}。用 bg_list 查看现有任务。`;
      const view = registry.statusView(task);
      const s = view.snapshot;
      const head = [
        `${s.id} [${s.status}] · 已运行 ${fmtDur(s.durationMs)}`,
        s.status !== 'running' ? `退出码 ${s.exitCode === null ? 'null' : s.exitCode}` : `安静 ${Math.round(s.quietMs / 1000)}s · 下次汇报 ~${Math.round((s.nextReportInMs ?? 0) / 1000)}s`,
        `命令: ${s.command}`,
      ].join('\n');
      // 增量预算：超出时按头 60% + 尾 40% 截断（与前台截断同比例）。readOffset
      // 已在 statusView 中推进全量——被略过的中段不会再次出现，只可从日志恢复。
      let body = view.newOutput;
      const overBudget = body.length > BG_STATUS_MAX_CHARS;
      if (overBudget) {
        const headSize = Math.floor(BG_STATUS_MAX_CHARS * 0.6);
        const omitted = body.length - BG_STATUS_MAX_CHARS;
        body = body.slice(0, headSize)
          + `\n…[增量过长：已省略中段 ${omitted} 字符]\n`
          + body.slice(-(BG_STATUS_MAX_CHARS - headSize));
      }
      const catchUp = view.unsentCatchUp;
      const clampedNote = view.clamped
        ? '\n（注：部分早期输出超出内存缓冲，完整内容在日志文件中）'
        : '';
      const logNote = overBudget || view.clamped ? `\n${registry.logHint(task)}` : '';
      const bodyText = body
        ? `\n\n新增输出:\n${body}`
        : '\n\n（自上次查看以来无新增输出）';
      return withDisplay(
        head + bodyText + clampedNote + logNote + (catchUp.length > 0 ? `\n\n[未送达通知]\n${catchUp.join('\n---\n')}` : ''),
        {
          kind: 'bg-status',
          taskId: s.id,
          status: s.status,
          durationMs: s.durationMs,
          exitCode: s.exitCode,
          quietMs: s.quietMs,
          nextReportInMs: s.nextReportInMs,
          command: s.command,
          newOutput: body,
          outputTruncated: overBudget,
          clamped: view.clamped,
          ...(overBudget || view.clamped ? { logHint: registry.logHint(task) } : {}),
          ...(catchUp.length > 0 ? { catchUp } : {}),
        },
      );
    },
  });
}

export function createBgWatchTool(registry: BgRegistry, access: BackgroundAccess): Tool {
  return createTool({
    name: 'bg_watch',
    description: BG_WATCH_INLINE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务号，如 bg-1' },
        keyword: { type: 'string', description: '要监控的关键词，20 字符以内；只匹配订阅之后的新输出' },
      },
      required: ['taskId', 'keyword'],
    },
    render: { call: 'bg', result: 'bg' },
    execute: async (args) => {
      const { taskId, keyword } = args as { taskId: string; keyword: string };
      const r = registry.subscribeKeywordWatch(taskId, keyword);
      if (!r.scheduled) {
        const s = r.snapshot;
        return `${taskId} 已结束（${terminalLabel(s.status, s.exitCode)}），运行 ${fmtDur(s.durationMs)}。`;
      }
      // 订阅当轮显式让出（一次性待命）：旧订阅此后只产生通知，不再干预
      // 流程决策——后续轮次不会被未命中的旧 watch 误停。
      access.requestStandby();
      return [
        `已订阅关键词监控 ${taskId}："${r.keyword}"——只匹配订阅之后的新输出，命中立即通知（含当时新增输出）；本回合到此结束，交由推送唤醒。`,
        `这是一次性订阅：命中即消耗，要继续盯同一关键词就再订阅一次。任务自身的自动汇报不受影响，照常送达。`,
      ].join('\n');
    },
  });
}

export function createBgTuneTool(registry: BgRegistry, access: BackgroundAccess): Tool {
  return createTool({
    name: 'bg_tune',
    description: BG_TUNE_INLINE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务号，如 bg-1' },
        intervalSec: { type: 'number', description: '汇报间隔（秒）：两条运行汇报之间的最大间隔。最小 60，填小按 60 算' },
        quietAfterSec: { type: 'number', description: '静默提醒阈值（秒）：连续静默这么久后开始提醒。最小 30，填小按 30 算' },
        then: { type: 'string', description: '填 "standby"：调整后立即结束当前回合、进入待命，由后续汇报/提醒/完成通知自动唤醒' },
      },
      required: ['taskId'],
    },
    render: { call: 'bg', result: 'bg' },
    execute: async (args) => {
      const { taskId, intervalSec, quietAfterSec, then } = args as {
        taskId: string; intervalSec?: number; quietAfterSec?: number; then?: string;
      };
      const standby = then === 'standby';
      if (intervalSec === undefined && quietAfterSec === undefined && !standby) {
        return '未指定调整项。可用：intervalSec（汇报间隔）/ quietAfterSec（静默提醒阈值）/ then="standby"（调整后进入待命），至少传一项。';
      }
      const standbyNote = '已进入待命，本回合到此结束；任务有新进展会自动汇报，静默超时会提醒，结束时完整结果立即送达。';
      if (intervalSec === undefined && quietAfterSec === undefined) {
        // 仅 standby：先核实现状——目标不存在或已终态时返回现状，不盲登记
        // 待命（通用层消费空待命也不生效）。
        const task = registry.get(taskId);
        if (!task) return `未找到后台任务 ${taskId}。用 bg_list 查看现有任务。`;
        if (task.status !== 'running') {
          const s = registry.snapshot(task);
          return `${taskId} 已结束（${terminalLabel(s.status, s.exitCode)}），运行 ${fmtDur(s.durationMs)}。`;
        }
        access.requestStandby();
        return `节奏未调整（未指定 intervalSec / quietAfterSec）。${standbyNote}`;
      }
      const pace = registry.tune(taskId, {
        ...(intervalSec !== undefined ? { intervalMs: Math.round(intervalSec * 1000) } : {}),
        ...(quietAfterSec !== undefined ? { quietAfterMs: Math.round(quietAfterSec * 1000) } : {}),
      });
      if (!pace) return `未找到运行中的后台任务 ${taskId}。用 bg_list 查看现有任务。`;
      if (standby) {
        access.requestStandby();
        return `汇报节奏已调整：每 ${Math.round(pace.intervalMs / 1000)}s 一条运行汇报 / 静默 ${Math.round(pace.quietAfterMs / 1000)}s 起提醒（已重新计时，下次汇报最坏 ${Math.round(pace.intervalMs / 1000)}s 后）。${standbyNote}`;
      }
      return `汇报节奏已调整：每 ${Math.round(pace.intervalMs / 1000)}s 一条运行汇报 / 静默 ${Math.round(pace.quietAfterMs / 1000)}s 起提醒（已重新计时，下次汇报最坏 ${Math.round(pace.intervalMs / 1000)}s 后）。此后由自动汇报驱动，无需重复调用。`;
    },
  });
}

export function createBgWriteTool(registry: BgRegistry): Tool {
  return createTool({
    name: 'bg_write',
    description: BG_WRITE_INLINE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务号，如 bg-1' },
        text: { type: 'string', description: '要写入 stdin 的文本，通常以 \\n 结尾' },
      },
      required: ['taskId', 'text'],
    },
    render: { call: 'bg', result: 'bg' },
    execute: async (args) => {
      const { taskId, text } = args as { taskId: string; text: string };
      const task = registry.get(taskId);
      if (!task) return `未找到后台任务 ${taskId}。用 bg_list 查看现有任务。`;
      return registry.writeStdin(taskId, text)
        ? `已写入 ${taskId} 的 stdin。`
        : `写入失败：${taskId} 不在运行或 stdin 不可用。`;
    },
  });
}

export function createBgKillTool(registry: BgRegistry): Tool {
  return createTool({
    name: 'bg_kill',
    description: BG_KILL_INLINE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务号，如 bg-1' },
      },
      required: ['taskId'],
    },
    render: { call: 'bg', result: 'bg' },
    execute: async (args) => {
      const { taskId } = args as { taskId: string };
      const task = registry.get(taskId);
      if (!task) return `未找到后台任务 ${taskId}。用 bg_list 查看现有任务。`;
      if (registry.kill(taskId, { graceful: true })) {
        return `已停止 ${taskId}。`;
      }
      const snapshot = registry.snapshot(task);
      const tail = registry.tail(task, 1_000);
      return [
        `${taskId} 已结束（${terminalLabel(snapshot.status, snapshot.exitCode)}），运行 ${fmtDur(snapshot.durationMs)}。`,
        ...(tail ? [`尾部输出:\n${tail}`] : []),
      ].join('\n');
    },
  });
}
