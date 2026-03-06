/**
 * Shell Feature 工具定义
 *
 * 提供 run_shell_command 工具，通过 Git Bash 执行 Shell 命令
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import { cwd } from 'process';
import type { Tool } from '../../core/types.js';
import { createTool } from '../../core/tool.js';

const execAsync = promisify(exec);

// Git Bash 路径（Windows 默认安装位置）
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

// 自定义 bashrc 路径（用于安全限制，如禁用 rm 命令）
const CUSTOM_BASHRC = resolve(cwd(), '.agentdev/bashrc');

/**
 * 创建 run_shell_command 工具
 *
 * @param description 工具描述（从外部文件加载）
 * @returns Tool 实例
 */
export function createShellCommandTool(description: string): Tool {
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
      console.log(`[shell] ${command}`);
      try {
        // 使用 --rcfile 加载自定义配置，-i 确保是交互式 shell（函数生效）
        const bashCommand = `"${GIT_BASH}" --rcfile "${CUSTOM_BASHRC}" -i -c "${command.replace(/"/g, '\\"')}"`;
        const { stdout, stderr } = await execAsync(bashCommand);
        return stdout || stderr;
      } catch (error: any) {
        const output = error.stdout || error.stderr || error.message;
        throw new Error(output);
      }
    },
  });
}
