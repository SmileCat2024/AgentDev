/**
 * PowerShell 命令执行工具
 *
 * 提供 PowerShell 路径检测、命令执行和工具定义。
 * 与 bash 工具平行，共享输出截断逻辑。
 */

import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import type { Tool } from '../../core/types.js';
import { createTool } from '../../core/tool.js';
import { processOutputWithPersistence, type ShellExecutionResult } from './tools.js';

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
// 核心运行逻辑
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000;     // 10 minutes

export interface PowerShellToolOptions {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
  /** 已检测到的 PowerShell 路径 */
  psPath?: string;
  /** Timeout in milliseconds (default: 120000 = 2 min) */
  timeoutMs?: number;
}

/**
 * 运行 PowerShell 命令（支持 AbortSignal 中断）
 */
export async function runPowerShellCommand(
  command: string,
  options: PowerShellToolOptions = {},
  signal?: AbortSignal,
): Promise<ShellExecutionResult> {
  const workdir = options.workdir || options.workspaceDir || process.cwd();
  const psPath = options.psPath || findPowerShellPath();

  if (!psPath) {
    throw new Error('PowerShell not found.');
  }

  console.log(`[powershell] ${command}`);

  const psArgs = ['-NoProfile', '-NonInteractive', '-Command', command];

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timeoutMs = Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const isWin = process.platform === 'win32';

    const child = spawn(psPath, psArgs, {
      cwd: workdir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // On Linux/macOS, detached: true enables process group kill on timeout/abort.
      ...(!isWin ? { detached: true } : {}),
    });

    const killChild = () => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(-child.pid!, 'SIGKILL');
        }
      } catch {
        // 进程可能已经退出
      }
    };

    const onAbort = () => {
      console.log(`[powershell] signal abort detected, killing child PID=${child.pid}`);
      killChild();
    };

    const timeoutId = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      console.log(`[powershell] command timed out after ${timeoutMs}ms, killing PID=${child.pid}`);
      killChild();
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        const err: any = new Error('Command interrupted before execution');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);

      if (timedOut) {
        processOutputWithPersistence(stdout || '', workdir).then(truncatedStdout => {
          reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s\n\n${truncatedStdout || stderr}`));
        }).catch(() => {
          reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`));
        });
        return;
      }

      if (signal?.aborted) {
        const err: any = new Error('Command interrupted');
        err.name = 'AbortError';
        reject(err);
        return;
      }

      const cleanStderr = stderr.trim();

      processOutputWithPersistence(stdout || '', workdir).then(truncatedStdout => {
        if (code === 0) {
          resolve({
            stdout: truncatedStdout,
            stderr: cleanStderr,
            output: truncatedStdout || cleanStderr,
          });
        } else {
          const output = truncatedStdout || cleanStderr;
          reject(new Error(output || `Command failed with exit code ${code}`));
        }
      }).catch(err => {
        reject(err);
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export function createPowerShellTool(
  description: string,
  options: PowerShellToolOptions = {},
): Tool {
  return createTool({
    name: 'powershell',
    description,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 600000). Defaults to 120000 (2 minutes).' },
      },
      required: ['command'],
    },
    render: { call: 'bash', result: 'bash' },
    execute: async (args, context) => {
      const { command, timeout } = args as { command: string; timeout?: number };
      const result = await runPowerShellCommand(command, { ...options, timeoutMs: timeout }, context?.signal);
      return result.output;
    },
  });
}
