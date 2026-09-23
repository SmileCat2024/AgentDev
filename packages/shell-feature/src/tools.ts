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
  SHELL_METADATA_OPEN,
  SHELL_METADATA_CLOSE,
  formatShellMetadata,
  MAX_OUTPUT_LENGTH,
  processOutputWithPersistence,
  // ShellRunContext 复用共享运行核心的上下文形状（signal/termination/progress）
  type ShellRunContext,
} from './shell-core.js';
import {
  FOREGROUND_BUDGET_DEFAULT_MS,
  cleanBashStderr,
  formatForegroundOutput,
  runForegroundWithBudget,
} from './bg-core.js';
import type { BgRegistry } from './bg-core.js';

export interface ShellCommandToolOptions {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
  /** Override bash path detection (used when ShellFeature pre-detects the path) */
  bashPath?: string;
  /**
   * 前台固定预算（毫秒）：预算内完成返回完整结果；超预算不打断进程，
   * 经 registry 转后台（继承本预算作为初始紧凑汇报节奏）。缺省 20s。
   */
  timeoutMs?: number;
  /** 转后台收养目标（缺省不注册——进程保持运行但无句柄，仅供不需要兜底的高级用法）。 */
  registry?: BgRegistry;
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
// 核心运行参数（前台固定预算的缺省值见 bg-core.ts FOREGROUND_BUDGET_DEFAULT_MS）
// ---------------------------------------------------------------------------

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
    cleanStderr: cleanBashStderr,
  });
}

export function createShellCommandTool(
  description: string,
  options: ShellCommandToolOptions = {},
): Tool {
  const budgetMs = options.timeoutMs ?? FOREGROUND_BUDGET_DEFAULT_MS;
  return createTool({
    name: 'bash',
    description: `${description}\n\n适用范围：短时、需要立即查看结果的前台命令。前台等待预算到期后命令会转入后台继续运行；对于预期长时间运行的构建、测试、开发服务器或无需立即等待的任务，请直接使用 bash_bg。`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
    render: { call: 'bash', result: 'bash' },
    // 前台预算对模型不可见、不可调（timeout 无 fromArg）：超预算不打断，
    // execute 内转后台并以"已转后台"文案 settle（ADR-0005 中断即结果）。
    timeout: {
      defaultMs: budgetMs,
      maxMs: budgetMs,
    },
    execute: async (args, context) => {
      const { command } = args as { command: string };
      const registry = options.registry;
      const workdir = options.workdir || options.workspaceDir || process.cwd();
      const effectiveBudgetMs = typeof context?.timeoutMs === 'number' ? context.timeoutMs : budgetMs;
      console.log(`[shell] ${command}`);

      const run = await runForegroundWithBudget(
        {
          command,
          workdir,
          bashPath: options.bashPath || findGitBashPath() || '',
          resourceRoot: options.resourceRoot || process.cwd(),
          budgetMs: effectiveBudgetMs,
          signal: context?.signal,
          ...(context?.termination ? { termination: context.termination as () => string | null } : {}),
          ...(context?.terminationDeadline ? { terminationDeadline: context.terminationDeadline as () => number | null } : {}),
        },
        (child, pre) => {
          if (!registry) {
            throw new Error('shell: 前台预算超时且未配置转后台 registry（装配错误）');
          }
          return registry.register(child, {
            command,
            workdir,
            intervalMs: effectiveBudgetMs,
            quietAfterMs: effectiveBudgetMs,
            inherited: true,
            preOutput: [pre.stdout, cleanBashStderr(pre.stderr)].filter(Boolean).join('\n'),
          });
        },
      );

      if (run.adoptedTask) {
        const task = run.adoptedTask;
        const sec = Math.round(effectiveBudgetMs / 1000);
        return [
          `命令超过前台等待预算（${sec}s），未被打断，已转为后台任务 ${task.id}。`,
          `命令: ${command}`,
          `当前按 ${sec}s 紧凑节奏汇报，一完成立刻收到完整结果；预计长跑可用 bg_control 放宽节奏（如 intervalSec=300）。`,
          '不要轮询或 sleep 等待——继续做别的事，或直接结束回合；消息会自动送达并唤醒你。主动查看用 bg_status。',
        ].join('\n');
      }

      const { outcome } = run;
      if (outcome.kind === 'terminated') {
        // 用户主动打断：部分输出 + <shell_metadata> 块（对齐 ADR-0005 finishTerminated 语义）。
        const combined = [outcome.stdout, cleanBashStderr(outcome.stderr)].filter(Boolean).join('\n');
        const [text, logPath] = await processOutputWithPersistence(combined || '', workdir, MAX_OUTPUT_LENGTH, true);
        const meta = formatShellMetadata({
          terminated: true,
          reason: outcome.reason as 'user' | 'timeout',
          durationMs: Math.round(outcome.durationMs),
          exitCode: null,
          outputBytes: Buffer.byteLength(combined, 'utf-8'),
          truncated: text.length < combined.length,
          logPath: logPath ?? null,
        });
        return text ? `${text}\n${meta}` : meta;
      }
      if (outcome.kind !== 'completed') {
        // runForegroundWithBudget 的 abort 分支总是伴随 adoptedTask；防御兜底。
        throw new Error('shell: 前台运行异常中止且无任务句柄');
      }
      const formatted = await formatForegroundOutput(
        outcome.code,
        outcome.stdout,
        cleanBashStderr(outcome.stderr),
        options.workdir || options.workspaceDir || process.cwd(),
      );
      if (!formatted.ok) {
        throw new Error(formatted.text || `Command failed with exit code ${outcome.code}`);
      }
      return formatted.text;
    },
  });
}
