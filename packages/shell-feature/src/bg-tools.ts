/**
 * 后台 Bash 工具族 — bash_bg / bg_list / bg_status / bg_wait / bg_control
 *
 * 工具面契约（与 .agentdev/prompts/tool-bash-bg.md 一致；description 兜底内联
 * 完整教学文案——resourceRoot 缺省环境下 prompts 文件读不到，防轮询协议声明
 * 不能依赖文件存在）：
 * - bash_bg 启动观察 2s：窗口内退出直接带回结果（预判错了，白捡前台体验）；
 * - 节奏参数单位为秒，模型侧声明 clamp（interval ≥ 60s / quietAfter ≥ 30s）；
 * - bg_wait 单次 ≤ 30s，超时不是失败（返回"仍在运行"）；长等靠完成注入；
 * - bg_control 的 tune 统一 clamp（转后台任务的 20s 继承节奏因此只能调宽）。
 */

import type { Tool } from '@agentdevjs/core';
import { createTool } from '@agentdevjs/core';
import type { BgRegistry, BgSpawnOptions } from './bg-core.js';
import {
  BG_CAPTURE_WINDOW_MS,
  BG_STATUS_MAX_CHARS,
  BG_WAIT_MAX_MS,
  cleanBashStderr,
  fmtDur,
  formatForegroundOutput,
  spawnBackgroundProcess,
} from './bg-core.js';
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
- quietAfterSec（可选，默认 60）：进程多少秒没有任何输出后，改按这个间隔报告"没动静"。最小 30，填小按 30 算
- readyPattern（可选）：输出中出现这段文字时，立即收到一次“已就绪”通知，适合 dev server

启动后观察 2 秒：窗口内结束的命令直接返回结果（失败时包含退出码）；仍在运行则返回任务号，后续进度与最终结果会自动送达。

较长任务可按需放宽节奏，例如：
- 构建 / 测试：intervalSec=300, quietAfterSec=30（有输出说明正常；突然安静大概率是卡了）
- dev server：intervalSec=600, quietAfterSec=600（安静是健康状态，别打扰），配 readyPattern 如 "listening on"

重要：不要轮询、不要 sleep 等待。完成与汇报会作为消息自动送达，你继续做别的事，或者直接结束回合即可——消息到达会自动唤醒你。需要主动查看时用 bg_status。`;

const BG_LIST_INLINE_DESCRIPTION = '列出全部后台任务的全景：任务号、命令、状态、运行时长、安静时长、当前汇报节奏、下次汇报倒计时。收到任何后台任务消息后，可用它掌握全局。';

const BG_STATUS_INLINE_DESCRIPTION = '查看一个后台任务的当前状态，并取回自上次查看以来的新增输出（超长增量只显示首尾，完整内容按提示的日志路径用 read 工具读取）。如果有因投递失败滞留的通知，会在这里补发。';

const BG_WAIT_INLINE_DESCRIPTION = '现场等待一个后台任务，至多 maxWaitSec（上限 30）秒：完成立刻拿到结果；到时间还没完，返回"仍在运行 + 新增输出"，这不是失败。它只适合"我觉得它马上就好"的短等待——更长的等待靠汇报消息，不要反复调用本工具轮询。';

const BG_CONTROL_INLINE_DESCRIPTION = '控制一个后台任务：kill 停掉（进程树终止；任务已结束时返回当前终态和尾部输出）；stdin 向任务写入输入（如回答安装程序的 y/n 确认）；intervalSec / quietAfterSec 修改汇报节奏，立刻生效（最小 60 / 30）。';

// ---------------------------------------------------------------------------
// bash_bg
// ---------------------------------------------------------------------------

export function createBashBgTool(description: string, opts: BgToolOptions): Tool {
  const { registry } = opts;
  return createTool({
    name: 'bash_bg',
    description,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令' },
        intervalSec: { type: 'number', description: '可选，默认 90 秒。活跃任务的最大汇报间隔，最小 60' },
        quietAfterSec: { type: 'number', description: '可选，默认 60 秒。无输出持续多久后按此节奏报告，最小 30' },
        readyPattern: { type: 'string', description: '可选：输出匹配该文字时发一次性"已就绪"消息（dev server 类用）' },
      },
      required: ['command'],
    },
    render: { call: 'bash', result: 'bash' },
    // 2s 捕获窗 + spawn/格式化开销的余量；超时兜底（正常路径远快于此）
    timeout: { defaultMs: 15_000, maxMs: 15_000 },
    execute: async (args) => {
      const { command, intervalSec = 90, quietAfterSec = 60, readyPattern } = args as {
        command: string; intervalSec?: number; quietAfterSec?: number; readyPattern?: string;
      };
      if (!Number.isFinite(intervalSec) || !Number.isFinite(quietAfterSec)) {
        throw new Error(`intervalSec 与 quietAfterSec 必须是数字（收到 intervalSec=${String(intervalSec)}, quietAfterSec=${String(quietAfterSec)}）`);
      }
      console.log(`[shell-bg] ${command}`);
      const child = spawnBackgroundProcess(command, opts);
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
        return `命令在捕获窗内已完成，退出码 ${captured.code}（你可能不需要后台模式）：\n${formatted.text}`;
      }

      let task;
      try {
        task = registry.register(child, {
          command,
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
      return [
        `后台任务已启动：${task.id}（已运行 ${fmtDur(s.durationMs)}）`,
        `命令: ${command}`,
        `节奏：每 ${Math.round(task.pace.intervalMs / 1000)}s 汇报一次；静默 ${Math.round(task.pace.quietAfterMs / 1000)}s 起按静默节奏报告${task.readyPattern ? '；输出匹配即报"已就绪"' : ''}`,
        '任务一结束会立刻收到完整结果。不要轮询或 sleep 等待——继续做别的事，或直接结束回合；消息会自动送达并唤醒你。',
        '需要主动查看用 bg_status；调整节奏 / 写入输入 / 停止用 bg_control。',
      ].join('\n');
    },
  });
}

// ---------------------------------------------------------------------------
// bg_list / bg_status / bg_wait / bg_control
// ---------------------------------------------------------------------------

export function createBgListTool(registry: BgRegistry): Tool {
  return createTool({
    name: 'bg_list',
    description: BG_LIST_INLINE_DESCRIPTION,
    parameters: { type: 'object', properties: {} },
    render: { call: 'default', result: 'text' },
    execute: async () => {
      const list = registry.list();
      if (list.length === 0) return '当前没有后台任务。';
      const lines = list.map((t) => {
        const parts = [
          `${t.id} [${t.status}]`,
          `已运行 ${fmtDur(t.durationMs)}`,
          t.status === 'running' ? `安静 ${Math.round(t.quietMs / 1000)}s` : `退出码 ${t.exitCode === null ? 'null' : t.exitCode}`,
          `节奏 ${Math.round(t.pace.intervalMs / 1000)}s/${Math.round(t.pace.quietAfterMs / 1000)}s${t.inheritedPace ? '（前台转入紧凑节奏，可 bg_control 放宽）' : ''}`,
          t.nextReportInMs !== null ? `下次汇报 ~${Math.round(t.nextReportInMs / 1000)}s` : '',
        ].filter(Boolean);
        return `${parts.join(' · ')}\n  命令: ${t.command}`;
      });
      return `后台任务全景（${list.filter((t) => t.status === 'running').length} 运行中 / ${list.length} 总计）：\n${lines.join('\n')}`;
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
    render: { call: 'default', result: 'text' },
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
      const catchUp = view.unsentCatchUp.length > 0
        ? `\n\n[滞留通知补发]\n${view.unsentCatchUp.join('\n---\n')}`
        : '';
      const clampedNote = view.clamped
        ? '\n（注：部分早期输出超出内存缓冲，完整内容在日志文件中）'
        : '';
      const logNote = overBudget || view.clamped ? `\n${registry.logHint(task)}` : '';
      const bodyText = body
        ? `\n\n新增输出:\n${body}`
        : '\n\n（自上次查看以来无新增输出）';
      return head + bodyText + clampedNote + logNote + catchUp;
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
        maxWaitSec: { type: 'number', description: '至多等待秒数，上限 30' },
      },
      required: ['taskId'],
    },
    render: { call: 'default', result: 'text' },
    timeout: { defaultMs: BG_WAIT_MAX_MS + 5_000, maxMs: BG_WAIT_MAX_MS + 5_000 },
    execute: async (args) => {
      const { taskId, maxWaitSec } = args as { taskId: string; maxWaitSec?: number };
      const waitMs = Math.round((maxWaitSec ?? 10) * 1000);
      const task = await registry.wait(taskId, waitMs);
      if (!task) {
        const s = registry.snapshot(registry.get(taskId)!);
        return [
          `${taskId} 仍在运行（已运行 ${fmtDur(s.durationMs)}，安静 ${Math.round(s.quietMs / 1000)}s）。`,
          '本次等待已到时（不是失败）。不建议继续反复等待——汇报消息会自动送达；确需干预用 bg_control。',
        ].join('\n');
      }
      const s = registry.snapshot(task);
      return `${taskId} 已结束 [${s.status}]，退出码 ${s.exitCode === null ? 'null' : s.exitCode}，运行 ${fmtDur(s.durationMs)}。尾部输出可用 bg_status 查看。`;
    },
  });
}

export function createBgControlTool(registry: BgRegistry): Tool {
  return createTool({
    name: 'bg_control',
    description: BG_CONTROL_INLINE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务号，如 bg-1' },
        kill: { type: 'boolean', description: 'true 时终止任务：先温和终止（允许收尾），2 秒未退出强杀进程树' },
        stdin: { type: 'string', description: '向任务 stdin 写入的文本（通常以 \\n 结尾）' },
        intervalSec: { type: 'number', description: '新的活跃节奏（秒），最小 60' },
        quietAfterSec: { type: 'number', description: '新的静默节奏（秒），最小 30' },
      },
      required: ['taskId'],
    },
    render: { call: 'default', result: 'text' },
    execute: async (args) => {
      const { taskId, kill, stdin, intervalSec, quietAfterSec } = args as {
        taskId: string; kill?: boolean; stdin?: string; intervalSec?: number; quietAfterSec?: number;
      };
      const task = registry.get(taskId);
      if (!task) return `未找到后台任务 ${taskId}。用 bg_list 查看现有任务。`;

      const actions: string[] = [];
      if (stdin !== undefined) {
        actions.push(registry.writeStdin(taskId, stdin)
          ? '已写入 stdin'
          : 'stdin 写入失败（任务不在运行或 stdin 不可用）');
      }
      if (intervalSec !== undefined || quietAfterSec !== undefined) {
        const pace = registry.tune(taskId, {
          ...(intervalSec !== undefined ? { intervalMs: Math.round(intervalSec * 1000) } : {}),
          ...(quietAfterSec !== undefined ? { quietAfterMs: Math.round(quietAfterSec * 1000) } : {}),
        });
        if (pace) {
          actions.push(`节奏已调整为每 ${Math.round(pace.intervalMs / 1000)}s 汇报 / 静默 ${Math.round(pace.quietAfterMs / 1000)}s 起（已重新计时，下次汇报最坏 ${Math.round(pace.intervalMs / 1000)}s 后）`);
        } else {
          actions.push('节奏调整失败：任务不在运行');
        }
      }
      if (kill === true) {
        if (registry.kill(taskId, { graceful: true })) {
          actions.push('已发送终止信号（未及时退出会自动强杀）');
        } else {
          const snapshot = registry.snapshot(task);
          const tail = registry.tail(task, 1_000);
          actions.push([
            `任务不在运行，当前状态 [${snapshot.status}]，退出码 ${snapshot.exitCode === null ? 'null' : snapshot.exitCode}，运行 ${fmtDur(snapshot.durationMs)}。`,
            ...(tail ? [`尾部输出:\n${tail}`] : []),
          ].join('\n'));
        }
      }
      if (actions.length === 0) {
        return '未指定操作。可用：kill / stdin / intervalSec / quietAfterSec。';
      }
      return actions.join('\n');
    },
  });
}
