/**
 * Grep 工具 - 内容搜索
 * 来自 opencode 项目的优秀实现
 */

import { createTool } from '../../core/tool.js';
import { spawn } from 'child_process';
import path from 'path';

const MAX_LINE_LENGTH = 2000;
const LIMIT = 100;

/**
 * 获取 ripgrep 路径
 */
async function getRipgrepPath(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', ['--version'], { windowsHide: true });
    let hasOutput = false;

    child.stdout.on('data', () => { hasOutput = true; });
    child.stderr.on('data', () => { hasOutput = true; });

    child.on('close', (code) => {
      if (hasOutput || code === 0) {
        resolve('rg');
      } else {
        reject(new Error('ripgrep (rg) is not installed. Please install it from https://github.com/BurntSushi/ripgrep'));
      }
    });

    child.on('error', () => {
      reject(new Error('ripgrep (rg) is not installed. Please install it from https://github.com/BurntSushi/ripgrep'));
    });
  });
}

/**
 * Grep 内容搜索工具
 */
export const grepTool = createTool({
  name: 'grep',
  description: 'A powerful search tool built on ripgrep. Supports full regex syntax, file type filtering, and context control. Use this tool for content searches; NEVER invoke grep or rg as Bash commands.',
  render: 'grep',
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
      // 使用 spawn 避免在 Windows 上 shell 解析特殊字符（如 |）的问题
      const stdout = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const child = spawn(rgPath, args, {
          windowsHide: true
        });

        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => {
          // ripgrep 将匹配结果输出到 stdout，错误信息到 stderr
        });

        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          if (context?.signal?.aborted) {
            return reject(new Error('Search was aborted'));
          }
          // code 1 表示没有匹配，不是错误
          if (code !== 0 && code !== 1) {
            return reject(new Error(`rg exited with code ${code}`));
          }
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });

        // 支持取消
        if (context?.signal) {
          context.signal.addEventListener('abort', () => {
            child.kill();
          });
        }
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
      if (error.message?.includes('Search was aborted') || context?.signal?.aborted) {
        throw new Error('Search was aborted');
      }
      throw error;
    }
  }
});
