/**
 * Grep 工具 - 内容搜索
 * 来自 opencode 项目的优秀实现
 */

import { createTool } from '../../core/tool.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

const MAX_LINE_LENGTH = 2000;
const LIMIT = 100;

/**
 * 获取 ripgrep 路径
 */
async function getRipgrepPath(): Promise<string> {
  try {
    // 尝试使用 rg 命令
    await execAsync('rg --version');
    return 'rg';
  } catch {
    throw new Error('ripgrep (rg) is not installed. Please install it from https://github.com/BurntSushi/ripgrep');
  }
}

/**
 * Grep 内容搜索工具
 */
export const grepTool = createTool({
  name: 'grep',
  description: 'A powerful search tool built on ripgrep. Supports full regex syntax, file type filtering, and context control. Use this tool for content searches; NEVER invoke grep or rg as Bash commands.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regex pattern to search for in file contents'
      },
      searchPath: {
        type: 'string',
        description: 'The directory to search in (defaults to current working directory)'
      },
      include: {
        type: 'string',
        description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'
      }
    },
    required: ['pattern']
  },
  execute: async ({ pattern, searchPath = process.cwd(), include }, context) => {
    console.log(`[grep] ${pattern} in ${searchPath}`);

    const rgPath = await getRipgrepPath();
    const args = ['-nH', '--hidden', '--no-messages', '--field-match-separator=|', '--regexp', pattern];

    if (include) {
      args.push('--glob', include);
    }
    args.push(searchPath);

    try {
      const { stdout } = await execAsync(`${rgPath} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`, {
        signal: context?.signal,
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });

      const lines = stdout.trim().split(/\r?\n/);
      const matches: Array<{ path: string; lineNum: number; lineText: string; modTime: number }> = [];

      for (const line of lines) {
        if (!line) continue;

        const parts = line.split('|');
        if (parts.length < 3) continue;

        const [filePath, lineNumStr, ...lineTextParts] = parts;
        const lineNum = parseInt(lineNumStr, 10);
        const lineText = lineTextParts.join('|');

        try {
          const fs = await import('fs/promises');
          const stats = await fs.stat(filePath);
          matches.push({
            path: filePath,
            lineNum,
            lineText: lineText.length > MAX_LINE_LENGTH ? lineText.substring(0, MAX_LINE_LENGTH) + '...' : lineText,
            modTime: stats.mtimeMs
          });
        } catch {
          // File may not exist, skip
        }
      }

      // 按修改时间排序
      matches.sort((a, b) => b.modTime - a.modTime);

      const truncated = matches.length > LIMIT;
      const finalMatches = truncated ? matches.slice(0, LIMIT) : matches;

      return {
        pattern,
        matches: matches.length,
        truncated,
        results: finalMatches
      };
    } catch (error: any) {
      // ripgrep 返回 1 表示没有匹配，不是错误
      if (error.signal === 'SIGTERM' || context?.signal?.aborted) {
        throw new Error('Search was aborted');
      }
      if (error.code === 1 || (error.stderr && error.stderr.includes('no matches found'))) {
        return {
          pattern,
          matches: 0,
          truncated: false,
          results: []
        };
      }
      throw error;
    }
  }
});
