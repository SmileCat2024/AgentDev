/**
 * 后台 Bash 工具族 — bash_bg / bg_list / bg_status / bg_wait / bg_tune / bg_write / bg_kill
 *
 * 工具面契约（与 .agentdev/prompts/tool-bash-bg.md 一致；description 兜底内联
 * 完整教学文案——resourceRoot 缺省环境下 prompts 文件读不到，防轮询协议声明
 * 不能依赖文件存在）：
 * - bash_bg 启动观察 2s：窗口内退出直接带回结果（预判错了，白捡前台体验）；
 * - 节奏参数单位为秒，模型侧声明 clamp（interval ≥ 60s / quietAfter ≥ 30s）；
 * - bg_wait 不占用工具调用：登记 afterSec 后的到点检查即返回，本回合随即
 *   结束（StepFinish guard），等待由通知推送承载（≤ 120s，长等待走 intervalSec）；
 * - 观察与进程干预分面：bg_tune 调汇报节奏（统一 clamp，转后台任务的 20s
 *   继承节奏因此只能调宽）、bg_write 写 stdin、bg_kill 停止。
 */

import type { Tool } from '@agentdevjs/core';
import { createTool, withDisplay, withRewrite } from '@agentdevjs/core';
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
}

// ---------------------------------------------------------------------------
// 内联兜底描述（prompts 文件缺失时的完整教学文案）
// ---------------------------------------------------------------------------

export const BASH_BG_INLINE_DESCRIPTION = `在后台启动一条 bash 命令，适合构建、测试、开发服务器等长时间运行或无需立即等待结果的任务。短任务或需要立即拿到结果的命令请用前台 bash。

参数说明：
- command：要执行的 bash 命令
- intervalSec（可选，默认 90）：任务正常运行时，最坏每隔这么多秒收到一条进度消息。最小 60，填小按 60 算
- quietAfterSec（可选，默认 60）：进程多少秒没有任何输出后，开始收到"无新输出"提醒。最小 30，填小按 30 算
- readyPattern（可选）：输出中出现这段文字时，立即收到一次“已就绪”通知，适合 dev server

启动后观察 2 秒：窗口内结束的命令直接返回结果（失败时包含退出码）；仍在运行则返回任务号，后续进度与最终结果会自动送达。

较长任务可按需放宽汇报间隔，例如：
- 构建 / 测试：intervalSec=300, quietAfterSec=30（有输出说明正常；突然安静大概率是卡了）
- dev server：intervalSec=600, quietAfterSec=600（安静是健康状态，别打扰），配 readyPattern 如 "listening on"

重要：不要轮询、不要 sleep 等待。完成与汇报会作为消息自动送达，你继续做别的事，或者直接结束回合即可——消息到达会自动唤醒你。需要主动查看时用 bg_status。`;

const BG_LIST_INLINE_DESCRIPTION = '列出全部后台任务的全景：任务号、命令、状态、运行时长、安静时长、当前汇报间隔、下次汇报倒计时。收到任何后台任务消息后，可用它掌握全局。';

const BG_STATUS_INLINE_DESCRIPTION = '查看一个后台任务的当前状态，并取回自上次查看以来的新增输出（超长增量只显示首尾，完整内容按提示的日志路径用 read 工具读取）。如果有因投递失败滞留的通知，会在这里补发。';

const BG_WAIT_INLINE_DESCRIPTION = '安排一次到点检查并立即进入等待：调用后本回合随即结束，afterSec 秒后任务仍在运行则自动收到一条运行汇报（含新增输出）；任务提前完成则完成通知更早唤醒你。这是一次性订阅——之后的进展交给任务的自动汇报（频率不合适用 bg_tune 调整），想立即看一眼用 bg_status。对已结束的任务调用会直接返回终态。';

const BG_TUNE_INLINE_DESCRIPTION = '调整一个后台任务的自动汇报节奏，立即生效并重新计时：intervalSec = 最多每隔这么多秒收到一条运行汇报（最小 60）；quietAfterSec = 连续静默多少秒后开始收到提醒（最小 30）。任务比预期跑得久、汇报太吵时放宽（如构建类任务 intervalSec=300）；想盯得更密也用它。调整一次长期生效，无需反复调用。';

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
          `汇报：每 ${Math.round(task.pace.intervalMs / 1000)}s 推送一次运行情况；连续 ${Math.round(task.pace.quietAfterMs / 1000)}s 无输出时会推送"无新输出"提醒${task.readyPattern ? '；输出匹配即报"已就绪"' : ''}`,
          '任务一结束会立刻收到完整结果。不要轮询或 sleep 等待——继续做别的事，或直接结束回合；消息会自动送达并唤醒你。',
          '查看详情用 bg_status；调节奏用 bg_tune；向任务输入用 bg_write；停止任务用 bg_kill。',
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
// bg_list / bg_status / bg_wait / bg_tune / bg_write / bg_kill
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
        head + bodyText + clampedNote + logNote + (catchUp.length > 0 ? `\n\n[滞留通知补发]\n${catchUp.join('\n---\n')}` : ''),
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

export function createBgWaitTool(registry: BgRegistry): Tool {
  return createTool({
    name: 'bg_wait',
    description: BG_WAIT_INLINE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务号，如 bg-1' },
        afterSec: { type: 'number', description: '多少秒后自动检查并汇报一次，默认 30，上限 120' },
      },
      required: ['taskId'],
    },
    render: { call: 'bg', result: 'bg' },
    execute: async (args) => {
      const { taskId, afterSec } = args as { taskId: string; afterSec?: number };
      const afterMs = Math.round((afterSec ?? 30) * 1000);
      const r = registry.scheduleWaitCheck(taskId, afterMs);
      if (!r.scheduled) {
        const s = r.snapshot;
        return `${taskId} 已结束（${terminalLabel(s.status, s.exitCode)}），运行 ${fmtDur(s.durationMs)}。`;
      }
      const s = r.snapshot;
      return [
        `已安排 ${r.waitSec}s 后检查 ${taskId}，立即进入等待——本回合到此结束，到点自动收到运行汇报（含新增输出）；任务提前完成则完成通知更早唤醒你。`,
        `${taskId} 自身的自动汇报：每 ${Math.round(s.pace.intervalMs / 1000)}s 一条。之后无需再订阅等待——等自动汇报就好；觉得太密或太疏，用 bg_tune 调一次节奏，之后交给它。`,
      ].join('\n');
    },
  });
}

export function createBgTuneTool(registry: BgRegistry): Tool {
  return createTool({
    name: 'bg_tune',
    description: BG_TUNE_INLINE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务号，如 bg-1' },
        intervalSec: { type: 'number', description: '汇报间隔（秒）：最多每隔这么久收到一条运行汇报。最小 60，填小按 60 算' },
        quietAfterSec: { type: 'number', description: '静默提醒阈值（秒）：连续静默这么久后开始收到提醒。最小 30，填小按 30 算' },
      },
      required: ['taskId'],
    },
    render: { call: 'bg', result: 'bg' },
    execute: async (args) => {
      const { taskId, intervalSec, quietAfterSec } = args as {
        taskId: string; intervalSec?: number; quietAfterSec?: number;
      };
      if (intervalSec === undefined && quietAfterSec === undefined) {
        return '未指定调整项。可用：intervalSec（汇报间隔）/ quietAfterSec（静默提醒阈值），至少传一个。';
      }
      const pace = registry.tune(taskId, {
        ...(intervalSec !== undefined ? { intervalMs: Math.round(intervalSec * 1000) } : {}),
        ...(quietAfterSec !== undefined ? { quietAfterMs: Math.round(quietAfterSec * 1000) } : {}),
      });
      if (!pace) return `未找到运行中的后台任务 ${taskId}。用 bg_list 查看现有任务。`;
      return `汇报节奏已调整：每 ${Math.round(pace.intervalMs / 1000)}s 一条运行汇报 / 静默 ${Math.round(pace.quietAfterMs / 1000)}s 起提醒（已重新计时，下次汇报最坏 ${Math.round(pace.intervalMs / 1000)}s 后）。之后交给自动汇报，无需反复调用。`;
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
