/**
 * Glob 工具 - 文件模式搜索
 * 来自 opencode 项目的优秀实现
 */

import { glob } from 'glob';
import { createTool } from '../../core/tool.js';
import path from 'path';

/**
 * Glob 文件搜索工具
 */
export const globTool = createTool({
  name: 'glob',
  description: 'Fast file pattern matching tool that works with any codebase size. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against'
      },
      searchPath: {
        type: 'string',
        description: 'The directory to search in (defaults to current working directory)'
      }
    },
    required: ['pattern']
  },
  execute: async ({ pattern, searchPath = process.cwd() }) => {
    console.log(`[glob] ${pattern} in ${searchPath}`);

    const limit = 100;
    const files: Array<{ path: string; mtime: number }> = [];

    // 使用 glob 进行文件搜索
    const matches = await glob(pattern, {
      cwd: searchPath,
      absolute: true,
      windowsPathsNoEscape: true,
      nodir: true,
      ignore: {
        cwd: searchPath
      }
    });

    for (const file of matches) {
      if (files.length >= limit) break;

      try {
        const stats = await import('fs/promises').then(fs => fs.stat(file));
        files.push({
          path: file,
          mtime: stats.mtimeMs
        });
      } catch {
        // File may have been deleted, skip
      }
    }

    // 按修改时间排序
    files.sort((a, b) => b.mtime - a.mtime);

    const output: string[] = [];
    if (files.length === 0) {
      output.push('No files found');
    } else {
      output.push(...files.map(f => f.path));
      if (files.length >= limit) {
        output.push('');
        output.push(`(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`);
      }
    }

    return {
      count: files.length,
      truncated: files.length >= limit,
      files: files.map(f => f.path)
    };
  }
});
