/**
 * Shell Feature 工具定义 - Bash 执行工具
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import { cwd } from 'process';
import type { Tool } from 'agentdev';
import { createTool } from 'agentdev';

const execAsync = promisify(exec);

const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';
const CUSTOM_BASHRC = resolve(cwd(), '.agentdev/bashrc');

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
        const bashCommand = `"${GIT_BASH}" --rcfile "${CUSTOM_BASHRC}" -i -c "${command.replace(/"/g, '\\"')}"`;
        const { stdout, stderr } = await execAsync(bashCommand);
        const cleanStderr = stderr?.split('\n')
          .filter(line => !line.includes('process group') && !line.includes('job control'))
          .join('\n') || '';
        return stdout || cleanStderr;
      } catch (error: any) {
        const output = error.stdout || error.stderr || error.message;
        throw new Error(output);
      }
    },
  });
}
