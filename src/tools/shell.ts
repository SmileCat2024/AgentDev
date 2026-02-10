import { exec } from 'child_process';
import { promisify } from 'util';
import { createTool } from '../core/tool.js';

const execAsync = promisify(exec);

// Shell 命令
export const shellTool = createTool({
  name: 'run_shell_command',
  description: '执行 Shell 命令',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
    },
    required: ['command'],
  },
  execute: async ({ command }) => {
    console.log(`[shell] ${command}`);
    try {
      const { stdout, stderr } = await execAsync(command);
      return stdout || stderr;
    } catch (error: any) {
      return `Error: ${error.message}`;
    }
  },
});
