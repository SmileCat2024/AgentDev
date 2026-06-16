/**
 * Shell Feature 工具定义
 *
 * 提供 bash 工具，通过 Git Bash 执行 Shell 命令，支持 AbortSignal 中断。
 *
 * 改进点（照搬 Claude Code 的优秀实践）：
 * 1. 命令引用：eval + 单引号包裹，彻底解决 syntax error near unexpected token '('
 * 2. 非 -i 模式：去掉 interactive flag，消除 job control 警告
 * 3. stdin redirect：自动添加 < /dev/null 防止命令挂起
 * 4. Windows null rewrite：>nul → >/dev/null
 * 5. 动态 Git Bash 路径检测
 * 6. 输出截断：防止大输出撑爆 LLM 上下文
 */

import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import type { Tool } from 'agentdev';
import { createTool } from 'agentdev';
import {
  quoteShellCommand,
  shouldAddStdinRedirect,
  rewriteWindowsNullRedirect,
} from './shellQuoting.js';

export interface ShellCommandToolOptions {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
}

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
  output: string;
}

// ---------------------------------------------------------------------------
// 输出截断 + 落盘持久化（参考 Claude Code 的 toolResultStorage 策略）
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LENGTH = 30_000;

/**
 * 截断输出并持久化完整内容到磁盘。
 *
 * 当输出超过 limit 时：
 * 1. 将完整输出写入 workdir/.agentdev/temp/bash-output-<timestamp>-<random>.log
 * 2. 返回截断版本（头 60% + 尾 40%），中间插入截断提示和文件路径引用
 *
 * 如果写盘失败，fallback 到纯截断（不丢失截断提示，但完整内容不可恢复）。
 */
async function processOutputWithPersistence(
  output: string,
  workdir: string,
  limit: number = MAX_OUTPUT_LENGTH,
): Promise<string> {
  if (output.length <= limit) return output;

  const headSize = Math.floor(limit * 0.6);
  const tailSize = limit - headSize;
  const head = output.slice(0, headSize);
  const tail = output.slice(-tailSize);
  const omitted = output.length - limit;
  const totalKB = Math.round(output.length / 1024);

  // 尝试将完整输出持久化到磁盘
  let filePath: string | null = null;
  try {
    const tempDir = path.join(workdir, '.agentdev', 'temp');
    const now = new Date();
    const ts = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '-' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    const suffix = Math.random().toString(36).slice(2, 8);
    const fileName = `bash-output-${ts}-${suffix}.log`;
    filePath = path.join(tempDir, fileName);

    await mkdir(tempDir, { recursive: true });
    await writeFile(filePath, output, 'utf-8');
  } catch (err) {
    console.error(`[shell] Failed to persist output: ${err}`);
    filePath = null;
  }

  // 构建截断提示
  const persistNotice = filePath
    ? `[Full output (${totalKB}KB) saved to: ${filePath}]\nUse the read tool to access the full output if needed.\n`
    : '';

  return (
    head +
    `\n\n... [truncated: omitted ${omitted} characters (${totalKB}KB total)] ...\n${persistNotice}\n` +
    tail
  );
}

// ---------------------------------------------------------------------------
// 动态 Git Bash 路径检测（照搬 Claude Code 的 findGitBashPath）
// ---------------------------------------------------------------------------

let cachedBashPath: string | null = null;

/**
 * 动态查找 Git Bash 的 bash.exe 路径。
 *
 * 查找顺序：
 * 1. 环境变量 AGENTDEV_GIT_BASH_PATH
 * 2. 环境变量 SHELL（如果包含 bash）
 * 3. where bash（Windows）
 * 4. 常见安装位置
 */
function findGitBashPath(): string {
  if (cachedBashPath) return cachedBashPath;

  if (process.platform !== 'win32') {
    // Unix: 直接用 SHELL 或 /bin/bash
    cachedBashPath = process.env.SHELL || '/bin/bash';
    return cachedBashPath;
  }

  // Windows: 按优先级查找
  const candidates: string[] = [];

  // 1. 环境变量覆盖
  if (process.env.AGENTDEV_GIT_BASH_PATH) {
    candidates.push(process.env.AGENTDEV_GIT_BASH_PATH);
  }

  // 2. 常见安装位置（64-bit 优先于 32-bit）
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  candidates.push('C:\\Program Files (x86)\\Git\\bin\\bash.exe');

  // 3. 通过 where bash 查找
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

  // 4. 通过 git 路径推导
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

  // 回退到硬编码默认值（保持向后兼容）
  cachedBashPath = 'C:/Program Files/Git/bin/bash.exe';
  return cachedBashPath;
}

// ---------------------------------------------------------------------------
// 核心：运行 Shell 命令
// ---------------------------------------------------------------------------

/**
 * 运行 Shell 命令（支持 AbortSignal 中断）
 *
 * 关键改进：
 * - 使用 eval + 单引号引用替代 naive 的双引号转义
 * - 去掉 -i（interactive）flag
 * - 添加 stdin redirect
 * - 重写 Windows null redirect
 *
 * @param command 要执行的命令
 * @param options 执行选项
 * @param signal AbortSignal 用于中断命令执行
 */
export async function runShellCommand(
  command: string,
  options: ShellCommandToolOptions = {},
  signal?: AbortSignal,
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
  //    source bashrc 以保持 PATH、rm 拦截等配置
  //    用 || true 保证 bashrc 缺失时不阻断
  const quotedBashrc = `'${bashrcPath.replace(/'/g, `'\"'\"'`)}'`;
  const commandString = `source ${quotedBashrc} 2>/dev/null || true; eval ${quotedCommand}`;

  // 4. 确定 bash 路径和参数
  const bashPath = findGitBashPath();
  // 不使用 -i（interactive），消除 job control 警告
  const bashArgs = ['-c', commandString];

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(bashPath, bashArgs, {
      cwd: workdir,
      env: {
        ...process.env,
        // 设置 MSYS 相关环境以改善 Windows 兼容性
        MSYSTEM: process.env.MSYSTEM || 'MINGW64',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // 手动监听 signal abort——在 Windows 上 Git Bash 的子进程树
    // 不会被 spawn 的 signal 选项杀死，所以必须手动 kill
    const onAbort = () => {
      console.log(`[shell] signal abort detected, killing child PID=${child.pid}`);
      try {
        if (process.platform === 'win32') {
          // Windows: 用 taskkill /T 杀死整个进程树
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          // Unix: kill 整个进程组
          process.kill(-child.pid!, 'SIGKILL');
        }
      } catch {
        // 进程可能已经退出
      }
    };

    if (signal) {
      if (signal.aborted) {
        const err: any = new Error('Command interrupted before execution');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // 收集 stdout
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    // 收集 stderr
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // 处理进程退出
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);

      // 过滤掉 bash 在非 TTY 环境下的作业控制警告（保险措施，
      // 去掉 -i 后理论上不再出现，但保留以防万一）
      const cleanStderr = stderr
        .split('\n')
        .filter(line => !line.includes('process group') && !line.includes('job control'))
        .join('\n')
        .trim();

      if (signal?.aborted) {
        const err: any = new Error('Command interrupted');
        err.name = 'AbortError';
        reject(err);
        return;
      }

      // 截断输出并持久化完整内容到磁盘
      processOutputWithPersistence(stdout || '', workdir).then(truncatedStdout => {
        if (code === 0) {
          resolve({
            stdout: truncatedStdout,
            stderr: cleanStderr,
            output: truncatedStdout || cleanStderr,
          });
        } else {
          // 命令执行失败（非零退出码）
          const output = truncatedStdout || cleanStderr;
          reject(new Error(output || `Command failed with exit code ${code}`));
        }
      }).catch(err => {
        reject(err);
      });
    });

    // 处理错误（如 bash 找不到）
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

export function createShellCommandTool(
  description: string,
  options: ShellCommandToolOptions = {},
): Tool {
  return createTool({
    name: 'bash',
    description,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
    render: { call: 'bash', result: 'bash' },
    execute: async ({ command }, context?: { signal?: AbortSignal }) => {
      const result = await runShellCommand(command, options, context?.signal);
      return result.output;
    },
  });
}
