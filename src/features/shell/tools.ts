/**
 * Shell Feature 工具定义
 *
 * 提供 run_shell_command 工具，通过 Git Bash 执行 Shell 命令
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import type { Tool } from '../../core/types.js';
import { createTool } from '../../core/tool.js';

const execAsync = promisify(exec);

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

export async function runShellCommand(command: string, options: ShellCommandToolOptions = {}): Promise<ShellExecutionResult> {
  const workspaceDir = options.workspaceDir || process.cwd();
  const workdir = options.workdir || workspaceDir;
  const resourceRoot = options.resourceRoot || process.cwd();
  const bashrcPath = resolve(resourceRoot, '.agentdev/bashrc');

  console.log(`[shell] ${command}`);
  try {
    // 使用 --rcfile 加载自定义配置，-i 确保是交互式 shell（函数生效）
    const bashCommand = `"${GIT_BASH}" --rcfile "${bashrcPath}" -i -c "${command.replace(/"/g, '\\"')}"`;
    const { stdout, stderr } = await execAsync(bashCommand, { cwd: workdir });
    // 过滤掉 bash 在非 TTY 环境下的作业控制警告
    const cleanStderr = stderr?.split('\n')
      .filter(line => !line.includes('process group') && !line.includes('job control'))
      .join('\n') || '';
    return {
      stdout: stdout || '',
      stderr: cleanStderr,
      output: stdout || cleanStderr,
    };
  } catch (error: any) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const cleanStderr = stderr.split('\n')
      .filter((line: string) => !line.includes('process group') && !line.includes('job control'))
      .join('\n');
    throw new Error(stdout || cleanStderr || error.message);
  }
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
    execute: async ({ command }) => {
      const result = await runShellCommand(command, options);
      return result.output;
    },
  });
}
