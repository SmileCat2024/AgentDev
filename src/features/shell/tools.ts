/**
 * Shell Feature 工具定义
 *
 * 提供 run_shell_command 工具，通过 Git Bash 执行 Shell 命令
 */

import { spawn } from 'child_process';
import type { Tool } from '../../core/types.js';
import { createTool } from '../../core/tool.js';

// Git Bash 路径（Windows 默认安装位置）
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

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

/**
 * 运行 Shell 命令（支持 AbortSignal 中断）
 *
 * 注意：Windows 上 Git Bash 的子进程树不会被 Node.js spawn 的 signal 选项杀死，
 * 所以我们手动监听 signal 的 abort 事件来 kill 整个进程树。
 *
 * @param command 要执行的命令
 * @param options 执行选项
 * @param signal AbortSignal 用于中断命令执行
 */
export async function runShellCommand(
  command: string,
  options: ShellCommandToolOptions = {},
  signal?: AbortSignal
): Promise<ShellExecutionResult> {
  const workspaceDir = options.workspaceDir || process.cwd();
  const workdir = options.workdir || workspaceDir;
  const resourceRoot = options.resourceRoot || process.cwd();
  const bashrcPath = resourceRoot + '/.agentdev/bashrc';

  console.log(`[shell] ${command}`);
  console.log(`[shell] signal=${!!signal}, signal.aborted=${signal?.aborted}`);

  // 转义命令中的双引号
  const escapedCommand = command.replace(/"/g, '\\"');
  const bashArgs = ['--rcfile', bashrcPath, '-i', '-c', escapedCommand];

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    console.log(`[shell] spawning bash, signal passed=${!!signal}, aborted=${signal?.aborted}`);
    const child = spawn(GIT_BASH, bashArgs, {
      cwd: workdir,
      env: process.env,
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
      } catch (e) {
        // 进程可能已经退出
        console.log(`[shell] kill failed (process already exited?):`, e instanceof Error ? e.message : e);
      }
    };

    if (signal) {
      if (signal.aborted) {
        // signal 已经 aborted，不启动子进程
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

      // 过滤掉 bash 在非 TTY 环境下的作业控制警告
      const cleanStderr = stderr
        .split('\n')
        .filter(line => !line.includes('process group') && !line.includes('job control'))
        .join('\n');

      if (signal?.aborted) {
        // 被中断——抛出 AbortError 让上层识别
        console.log(`[shell] child closed due to abort`);
        const err: any = new Error('Command interrupted');
        err.name = 'AbortError';
        reject(err);
        return;
      }

      if (code === 0) {
        resolve({
          stdout: stdout || '',
          stderr: cleanStderr,
          output: stdout || cleanStderr,
        });
      } else {
        // 命令执行失败（非零退出码）
        const output = stdout || cleanStderr;
        reject(new Error(output || `Command failed with exit code ${code}`));
      }
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

/**
 * 创建 run_shell_command 工具
 *
 * @param description 工具描述（从外部文件加载）
 * @returns Tool 实例
 */
export function createShellCommandTool(description: string, options: ShellCommandToolOptions = {}): Tool {
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
