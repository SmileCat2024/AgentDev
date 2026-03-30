/**
 * Shell Feature 工具定义 - Bash 执行工具
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import type { Tool } from 'agentdev';
import { createTool } from 'agentdev';

const execAsync = promisify(exec);

const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

export interface ShellCommandToolOptions {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
}

export function createShellCommandTool(description: string, options: ShellCommandToolOptions = {}): Tool {
  const workspaceDir = options.workspaceDir || process.cwd();
  const workdir = options.workdir || workspaceDir;
  const resourceRoot = options.resourceRoot || process.cwd();
  const bashrcPath = resolve(resourceRoot, '.agentdev/bashrc');

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
        const bashCommand = `"${GIT_BASH}" --rcfile "${bashrcPath}" -i -c "${command.replace(/"/g, '\\"')}"`;
        const { stdout, stderr } = await execAsync(bashCommand, { cwd: workdir });
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
