/**
 * Shell Feature 工具定义
 *
 * 提供 run_shell_command 工具，通过 Git Bash 执行 Shell 命令
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import type { Tool, InlineRenderTemplate } from '../../core/types.js';
import { createTool } from '../../core/tool.js';

const execAsync = promisify(exec);

// Git Bash 路径（Windows 默认安装位置）
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

/**
 * HTML 转义辅助函数
 */
function escapeHtml(text: any): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Shell 命令渲染模板
 */
const shellCommandRender: InlineRenderTemplate = {
  call: (args) => `<div class="bash-command">> ${escapeHtml(args.command || '')}</div>`,
  result: (data, success) => {
    if (!success) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(text)}</span>
      </div>`;
    }
    return `<pre class="bash-output">${escapeHtml(data)}</pre>`;
  }
};

/**
 * 创建 run_shell_command 工具
 *
 * @param description 工具描述（从外部文件加载）
 * @returns Tool 实例
 */
export function createShellCommandTool(description: string): Tool {
  return createTool({
    name: 'run_shell_command',
    description,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
    render: shellCommandRender as any,
    execute: async ({ command }) => {
      console.log(`[shell] ${command}`);
      try {
        const { stdout, stderr } = await execAsync(command, {
          shell: GIT_BASH,
        });
        return stdout || stderr;
      } catch (error: any) {
        const output = error.stdout || error.stderr || error.message;
        throw new Error(output);
      }
    },
  });
}
