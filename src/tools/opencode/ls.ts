/**
 * LS 工具 - 目录列表
 * 来自 opencode 项目的优秀实现
 */

import { createTool } from '../../core/tool.js';
import { glob } from 'glob';
import path from 'path';

/**
 * 默认忽略的目录模式
 */
const IGNORE_PATTERNS = [
  'node_modules/**',
  '__pycache__/**',
  '.git/**',
  'dist/**',
  'build/**',
  'target/**',
  'vendor/**',
  'bin/**',
  'obj/**',
  '.idea/**',
  '.vscode/**',
  '.zig-cache/**',
  'zig-out/**',
  '.coverage/**',
  'coverage/**',
  'tmp/**',
  'temp/**',
  '.cache/**',
  'cache/**',
  'logs/**',
  '.venv/**',
  'venv/**',
  'env/**'
];

const LIMIT = 100;

/**
 * 目录列表工具
 */
export const lsTool = createTool({
  name: 'ls',
  description: 'List files in a directory with tree structure output. Automatically ignores common build/cache directories.',
  render: 'ls',
  parameters: {
    type: 'object',
    properties: {
      dirPath: {
        type: 'string',
        description: 'The absolute path to the directory to list'
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of glob patterns to ignore'
      }
    },
    required: ['dirPath']
  },
  execute: async ({ dirPath, ignore = [] }) => {
    console.log(`[ls] ${dirPath}`);

    const ignoreGlobs = [...IGNORE_PATTERNS, ...ignore.map((p: string) => `${p}/**`)];

    // glob 返回 Promise<string[]>，不是异步迭代器
    const matches = await glob('**/*', {
      cwd: dirPath,
      absolute: false,
      dot: true,
      ignore: ignoreGlobs,
      nodir: true
    });

    const files: string[] = [];
    for (const file of matches) {
      files.push(file);
      if (files.length >= LIMIT) break;
    }

    // 构建目录结构
    const dirs = new Set<string>();
    const filesByDir = new Map<string, string[]>();

    for (const file of files) {
      const dir = path.dirname(file);
      const parts = dir === '.' ? [] : dir.split(path.sep);

      // 添加所有父目录
      for (let i = 0; i <= parts.length; i++) {
        const dirPath = i === 0 ? '.' : parts.slice(0, i).join(path.sep);
        dirs.add(dirPath);
      }

      // 将文件添加到其目录
      if (!filesByDir.has(dir)) {
        filesByDir.set(dir, []);
      }
      filesByDir.get(dir)!.push(path.basename(file));
    }

    // 渲染目录树
    function renderDir(dirPath: string, depth: number): string {
      const indent = '  '.repeat(depth);
      let output = '';

      if (depth > 0) {
        output += `${indent}${path.basename(dirPath)}/\n`;
      }

      const children = Array.from(dirs)
        .filter((d) => path.dirname(d) === dirPath && d !== dirPath)
        .sort();

      // 先渲染子目录
      for (const child of children) {
        output += renderDir(child, depth + 1);
      }

      // 渲染文件
      const dirFiles = filesByDir.get(dirPath) || [];
      for (const file of dirFiles.sort()) {
        output += `${'  '.repeat(depth + 1)}${file}\n`;
      }

      return output;
    }

    const treeOutput = `${dirPath}${path.sep}\n${renderDir('.', 0)}`;

    return {
      path: dirPath,
      count: files.length,
      truncated: files.length >= LIMIT,
      tree: treeOutput
    };
  }
});
