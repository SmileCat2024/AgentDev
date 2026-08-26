/**
 * Shell Feature 工具定义
 *
 * 提供 bash 工具，在 Windows 上通过 Git Bash、在 Linux/macOS 上通过原生 bash 执行 Shell 命令，支持 AbortSignal 中断。
 *
 * 改进点（照搬 Claude Code 的优秀实践）：
 * 1. 命令引用：eval + 单引号包裹，彻底解决 syntax error near unexpected token '('
 * 2. 非 -i 模式：去掉 interactive flag，消除 job control 警告
 * 3. stdin redirect：自动添加 < /dev/null 防止命令挂起
 * 4. Windows null rewrite：>nul → >/dev/null
 * 5. 动态 bash 路径检测（Windows: Git Bash; Linux/macOS: $SHELL || /bin/bash）
 * 6. 输出截断：防止大输出撑爆 LLM 上下文
 *
 * 终止语义（ticket 024 / ADR-0005）：超时计时归框架 executor（Tool.timeout
 * 声明契约）；signal aborted 时 kill → drain 到 EOF → resolve 部分输出 +
 * <shell_metadata> 块（见 shell-core.ts）。
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import type { Tool } from '@agentdevjs/core';
import { createTool } from '@agentdevjs/core';
import {
  quoteShellCommand,
  shouldAddStdinRedirect,
  rewriteWindowsNullRedirect,
} from './shellQuoting.js';
import {
  runCollectedProcess,
  // ShellRunContext 复用共享运行核心的上下文形状（signal/termination/progress）
  type ShellRunContext,
} from './shell-core.js';

export interface ShellCommandToolOptions {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
  /** Override bash path detection (used when ShellFeature pre-detects the path) */
  bashPath?: string;
  /** 覆盖默认超时（manifest 配置 defaultTimeoutMs）；缺省 120000 */
  timeoutMs?: number;
  /** 覆盖超时上限（manifest 配置 maxTimeoutMs）；缺省 600000 */
  maxTimeoutMs?: number;
}

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  output: string;
}

// ---------------------------------------------------------------------------
// 动态 Git Bash 路径检测（照搬 Claude Code 的 findGitBashPath）
// ---------------------------------------------------------------------------

let cachedBashPath: string | null = null;

/**
 * 动态查找 Git Bash 的 bash.exe 路径。
 *
 * 查找顺序：
 * 1. configuredPath 参数（来自 manifest 配置）
 * 2. 环境变量 AGENTDEV_GIT_BASH_PATH
 * 3. 环境变量 SHELL（如果包含 bash）
 * 4. where bash（Windows）
 * 5. 常见安装位置
 *
 * 返回 null 表示未找到（调用方应据此决定是否注册工具）。
 */
export function findGitBashPath(configuredPath?: string): string | null {
  if (cachedBashPath) return cachedBashPath;

  // 0. 用户在 manifest 中配置的路径
  if (configuredPath && existsSync(configuredPath)) {
    cachedBashPath = configuredPath;
    return cachedBashPath;
  }

  if (process.platform !== 'win32') {
    cachedBashPath = process.env.SHELL || '/bin/bash';
    return cachedBashPath;
  }

  const candidates: string[] = [];

  if (process.env.AGENTDEV_GIT_BASH_PATH) {
    candidates.push(process.env.AGENTDEV_GIT_BASH_PATH);
  }

  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  candidates.push('C:\\Program Files (x86)\\Git\\bin\\bash.exe');

  try {
    const result = execSync('where bash', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of result.split('\n').map(l => l.trim()).filter(Boolean)) {
      if (line.toLowerCase().includes('git')) {
        candidates.push(line);
      }
    }
  } catch {
    // where 命令可能不可用
  }

  try {
    const gitPath = execSync('where git', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0]?.trim();
    if (gitPath) {
      const derived = path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe');
      candidates.push(derived);
    }
  } catch {
    // git 可能不在 PATH
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      cachedBashPath = candidate;
      return cachedBashPath;
    }
  }

  cachedBashPath = null;
  return null;
}

// ---------------------------------------------------------------------------
// 核心运行参数与超时契约默认值
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000;     // 10 minutes

/**
 * 运行 Shell 命令（支持 AbortSignal 中断；终止时收集部分输出并附元数据块）
 *
 * 关键改进：
 * - 使用 eval + 单引号引用替代 naive 的双引号转义
 * - 去掉 -i（interactive）flag
 * - 添加 stdin redirect
 * - 重写 Windows null redirect
 */
export async function runShellCommand(
  command: string,
  options: ShellCommandToolOptions = {},
  context?: ShellRunContext,
): Promise<ShellExecutionResult> {
  const workspaceDir = options.workspaceDir || process.cwd();
  const workdir = options.workdir || workspaceDir;
  const resourceRoot = options.resourceRoot || process.cwd();
  const bashrcPath = resourceRoot.replace(/\\/g, '/') + '/.agentdev/bashrc';

  console.log(`[shell] ${command}`);

  // 1. 重写 Windows CMD 风格的 null redirect
  const normalizedCommand = rewriteWindowsNullRedirect(command);

  // 2. 安全引用命令
  const addStdinRedirect = shouldAddStdinRedirect(normalizedCommand);
  const quotedCommand = quoteShellCommand(normalizedCommand, addStdinRedirect);

  // 3. 构建 eval 命令字符串
  const quotedBashrc = `'${bashrcPath.replace(/'/g, `'\\''`)}'`;
  const commandString = `source ${quotedBashrc} 2>/dev/null || true; eval ${quotedCommand}`;

  // 4. 确定 bash 路径和参数
  const bashPath = options.bashPath || findGitBashPath();
  if (!bashPath) {
    const hint = process.platform === 'win32'
      ? 'Git Bash not found. Please install Git for Windows or configure the path in settings.'
      : 'Bash not found. Please ensure bash is installed or configure the path in settings.';
    throw new Error(hint);
  }

  const isWin = process.platform === 'win32';

  return runCollectedProcess({
    workdir,
    execPath: bashPath,
    args: ['-c', commandString],
    env: {
      ...process.env,
      // MSYSTEM is only meaningful for Git Bash (MSYS2/MinGW) on Windows.
      ...(isWin ? { MSYSTEM: process.env.MSYSTEM || 'MINGW64' } : {}),
    },
    logPrefix: '[shell]',
    signal: context?.signal,
    termination: context?.termination,
    terminationDeadline: context?.terminationDeadline,
    progress: context?.progress,
    cleanStderr: (stderr) => stderr
      .split('\n')
      .filter(line => !line.includes('process group') && !line.includes('job control'))
      .join('\n')
      .trim(),
  });
}

export function createShellCommandTool(
  description: string,
  options: ShellCommandToolOptions = {},
): Tool {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // max 是硬上限：default 配置超过 max 时收敛到 max，保证契约自洽
  const maxTimeoutMs = Math.max(options.maxTimeoutMs ?? MAX_TIMEOUT_MS, defaultTimeoutMs, 1);
  return createTool({
    name: 'bash',
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
    // 计时职责归框架 executor（ticket 023）：args.timeout 经 fromArg 消费并 clamp
    timeout: {
      defaultMs: defaultTimeoutMs,
      maxMs: maxTimeoutMs,
      fromArg: 'timeout',
    },
    execute: async (args, context) => {
      const { command } = args as { command: string };
      // 生效超时（executor clamp 后）经 toolContext 透传（工单 025 进度显示）
      const effectiveTimeoutMs = typeof context?.timeoutMs === 'number' ? context.timeoutMs : null;
      const result = await runShellCommand(command, options, {
        signal: context?.signal,
        termination: context?.termination,
        terminationDeadline: context?.terminationDeadline,
        progress: {
          callId: context?.callId,
          toolName: 'bash',
          timeoutMs: effectiveTimeoutMs,
        },
      });
      return result.output;
    },
  });
}
