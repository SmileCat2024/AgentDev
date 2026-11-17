/**
 * PowerShell 命令执行工具
 *
 * 提供 PowerShell 路径检测、命令执行和工具定义。
 * 与 bash 工具平行，共用 shell-core.ts 的「spawn + collect + 截断落盘 +
 * 终止收集」管线（ticket 024），行为逐项一致（render 模板本就共用 bash.render.ts）。
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { BackgroundAccess, Tool } from '@agentdevjs/core';
import { createTool, withDisplay } from '@agentdevjs/core';
import {
  formatForegroundOutput,
  runForegroundWithBudget,
  type BgRegistry,
} from './bg-core.js';
import { processOutputWithPersistence, formatShellMetadata, MAX_OUTPUT_LENGTH } from './shell-core.js';
import {
  runCollectedProcess,
  type ShellRunContext,
} from './shell-core.js';

// ---------------------------------------------------------------------------
// PowerShell 路径检测
// ---------------------------------------------------------------------------

let cachedPsPath: string | null | undefined = undefined;

/**
 * 查找 PowerShell 可执行文件路径。
 *
 * 查找顺序：
 * 1. configuredPath 参数（来自 manifest 配置）
 * 2. 环境变量 AGENTDEV_POWERSHELL_PATH
 * 3. pwsh（PowerShell 7+，跨平台）
 * 4. powershell.exe（Windows PowerShell 5.1）
 * 5. Windows 已知系统路径
 *
 * 返回 null 表示未找到。
 */
export function findPowerShellPath(configuredPath?: string): string | null {
  if (cachedPsPath !== undefined) return cachedPsPath;

  // 0. 用户在 manifest 中配置的路径
  if (configuredPath && existsSync(configuredPath)) {
    cachedPsPath = configuredPath;
    return cachedPsPath;
  }

  // 1. 环境变量
  if (process.env.AGENTDEV_POWERSHELL_PATH && existsSync(process.env.AGENTDEV_POWERSHELL_PATH)) {
    cachedPsPath = process.env.AGENTDEV_POWERSHELL_PATH;
    return cachedPsPath;
  }

  const isWin = process.platform === 'win32';
  const whereCmd = isWin ? 'where' : 'which';

  // 2. pwsh (PowerShell Core 7+)
  try {
    const result = execSync(`${whereCmd} pwsh`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const p = result.split('\n').map(l => l.trim()).filter(Boolean)[0];
    if (p && existsSync(p)) {
      cachedPsPath = p;
      return cachedPsPath;
    }
  } catch { /* pwsh not installed */ }

  // 3. powershell (Windows PowerShell 5.1, Windows only)
  if (isWin) {
    try {
      const result = execSync(`${whereCmd} powershell`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const p = result.split('\n').map(l => l.trim()).filter(Boolean)[0];
      if (p && existsSync(p)) {
        cachedPsPath = p;
        return cachedPsPath;
      }
    } catch { /* not in PATH */ }

    // 4. Windows 系统默认路径
    const sysPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    if (existsSync(sysPath)) {
      cachedPsPath = sysPath;
      return cachedPsPath;
    }
  }

  cachedPsPath = null;
  return null;
}

// ---------------------------------------------------------------------------
// 工具定义与超时契约
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 20_000; // 与 Bash 相同的前台预算

export interface PowerShellToolOptions {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
  /** 已检测到的 PowerShell 路径 */
  psPath?: string;
  /** 前台等待预算；超时后转入共享后台任务表。 */
  timeoutMs?: number;
  /** PowerShell 超时转后台时使用的共享任务表。 */
  registry?: BgRegistry;
  /** PowerShell 超时转后台时使用的任务归属接入。 */
  access?: BackgroundAccess;
}

/**
 * 运行 PowerShell 命令（支持 AbortSignal 中断；终止时收集部分输出并附元数据块）
 */
export function buildPowerShellInvocation(
  command: string,
  opts: { psPath: string },
): { execPath: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    execPath: opts.psPath,
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
    env: { ...process.env },
  };
}

export async function runPowerShellCommand(
  command: string,
  options: PowerShellToolOptions = {},
  context?: ShellRunContext,
): Promise<{ stdout: string; stderr: string; output: string }> {
  const workspaceDir = options.workspaceDir || process.cwd();
  const workdir = options.workdir || workspaceDir;
  const psPath = options.psPath || findPowerShellPath();

  if (!psPath) {
    throw new Error('PowerShell not found.');
  }

  console.log(`[powershell] ${command}`);

  const invocation = buildPowerShellInvocation(command, { psPath });
  return runCollectedProcess({
    workdir,
    ...invocation,
    logPrefix: '[powershell]',
    signal: context?.signal,
    termination: context?.termination,
    terminationDeadline: context?.terminationDeadline,
    progress: context?.progress,
  });
}

export function createPowerShellTool(
  description: string,
  options: PowerShellToolOptions = {},
): Tool {
  const budgetMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return createTool({
    name: 'powershell',
    description: `${description}\n\n适用范围：短时、需要立即查看结果的前台 PowerShell 命令。前台等待预算到期后命令会转入后台继续运行，后续使用 bg_status、bg_tune、bg_write 或 bg_kill 管理。`,
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    render: { call: 'bash', result: 'bash' },
    // 与 Bash 对齐：预算对模型不可见且不可调；超预算转后台而不是终止进程。
    timeout: { defaultMs: budgetMs, maxMs: budgetMs },
    execute: async (args, context) => {
      const { command } = args as { command: string };
      const psPath = options.psPath || findPowerShellPath();
      if (!psPath) throw new Error('PowerShell not found.');
      const workdir = options.workdir || options.workspaceDir || process.cwd();
      const effectiveBudgetMs = typeof context?.timeoutMs === 'number' ? context.timeoutMs : budgetMs;
      const registry = options.registry;
      const access = options.access;
      const run = await runForegroundWithBudget(
        {
          command,
          workdir,
          resourceRoot: options.resourceRoot || process.cwd(),
          budgetMs: effectiveBudgetMs,
          signal: context?.signal,
          ...(context?.termination ? { termination: context.termination as () => string | null } : {}),
          ...(context?.terminationDeadline ? { terminationDeadline: context.terminationDeadline as () => number | null } : {}),
          buildInvocation: () => buildPowerShellInvocation(command, { psPath }),
        },
        (child, pre) => {
          if (!registry || !access) {
            throw new Error('powershell: 前台预算超时且未配置转后台 registry/access（装配错误）');
          }
          return registry.register(child, {
            command,
            workdir,
            access,
            intervalMs: effectiveBudgetMs,
            quietAfterMs: effectiveBudgetMs,
            inherited: true,
            preOutput: [pre.stdout, pre.stderr.trim()].filter(Boolean).join('\\n'),
          });
        },
      );

      if (run.adoptedTask) {
        const task = run.adoptedTask;
        const sec = Math.round(effectiveBudgetMs / 1000);
        return withDisplay([
          `命令超过前台等待预算（${sec}s），未被打断，已转为后台任务 ${task.id}。`,
          `命令: ${command}`,
          `已继承紧凑汇报节奏：每 ${sec}s 一条、静默 ${sec}s 起提醒。若任务还要跑较久，用 bg_tune 放宽节奏。`,
          '任务结束时完整结果会立即送达；需要主动核查时用 bg_status。',
        ].join('\\n'), {
          kind: 'bg-started',
          taskId: task.id,
          command,
          intervalSec: sec,
          quietAfterSec: sec,
          inherited: true,
        });
      }

      if (run.outcome.kind === 'terminated') {
        const combined = [run.outcome.stdout, run.outcome.stderr.trim()].filter(Boolean).join('\\n');
        const [text, logPath] = await processOutputWithPersistence(combined, workdir, MAX_OUTPUT_LENGTH, true);
        const meta = formatShellMetadata({
          terminated: true,
          reason: run.outcome.reason as 'user' | 'timeout',
          durationMs: run.outcome.durationMs,
          exitCode: null,
          outputBytes: Buffer.byteLength(combined, 'utf8'),
          truncated: text.length < combined.length,
          logPath,
        });
        return text ? `${text}\\n${meta}` : meta;
      }

      if (run.outcome.kind !== 'completed') {
        throw new Error('powershell: 前台运行异常中止且无任务句柄');
      }
      const formatted = await formatForegroundOutput(
        run.outcome.code,
        run.outcome.stdout,
        run.outcome.stderr.trim(),
        workdir,
      );
      if (!formatted.ok) throw new Error(formatted.text || `PowerShell failed with exit code ${run.outcome.code}`);
      return formatted.text;
    },
  });
}
