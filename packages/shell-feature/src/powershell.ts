/**
 * PowerShell 命令执行工具
 *
 * 提供 PowerShell 路径检测、命令执行和工具定义。
 * 与 bash 工具平行，共用 shell-core.ts 的「spawn + collect + 截断落盘 +
 * 终止收集」管线（ticket 024），行为逐项一致（render 模板本就共用 bash.render.ts）。
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { Tool } from '@agentdev/core';
import { createTool } from '@agentdev/core';
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

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000;     // 10 minutes

export interface PowerShellToolOptions {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
  /** 已检测到的 PowerShell 路径 */
  psPath?: string;
  /** 覆盖默认超时（manifest 配置 defaultTimeoutMs）；缺省 120000 */
  timeoutMs?: number;
  /** 覆盖超时上限（manifest 配置 maxTimeoutMs）；缺省 600000 */
  maxTimeoutMs?: number;
}

/**
 * 运行 PowerShell 命令（支持 AbortSignal 中断；终止时收集部分输出并附元数据块）
 */
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

  return runCollectedProcess({
    workdir,
    execPath: psPath,
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
    env: { ...process.env },
    logPrefix: '[powershell]',
    signal: context?.signal,
    termination: context?.termination,
  });
}

export function createPowerShellTool(
  description: string,
  options: PowerShellToolOptions = {},
): Tool {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // max 是硬上限：default 配置超过 max 时收敛到 max，保证契约自洽
  const maxTimeoutMs = Math.max(options.maxTimeoutMs ?? MAX_TIMEOUT_MS, defaultTimeoutMs, 1);
  return createTool({
    name: 'powershell',
    description,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number', description: `Optional timeout in milliseconds (max ${maxTimeoutMs}). Defaults to ${defaultTimeoutMs}.` },
      },
      required: ['command'],
    },
    render: { call: 'bash', result: 'bash' },
    // 与 bash 一致：计时职责归框架 executor（ticket 023）
    timeout: {
      defaultMs: defaultTimeoutMs,
      maxMs: maxTimeoutMs,
      fromArg: 'timeout',
    },
    execute: async (args, context) => {
      const { command } = args as { command: string };
      // 生效超时（executor clamp 后）经 toolContext 透传（工单 025 进度显示）
      const effectiveTimeoutMs = typeof context?.timeoutMs === 'number' ? context.timeoutMs : null;
      const result = await runPowerShellCommand(command, options, {
        signal: context?.signal,
        termination: context?.termination,
        progress: {
          callId: context?.callId,
          toolName: 'powershell',
          timeoutMs: effectiveTimeoutMs,
        },
      });
      return result.output;
    },
  });
}
