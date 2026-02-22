/**
 * Read 工具 - 文件读取
 * 来自 opencode 项目的优秀实现
 */

import { createTool } from '../../core/tool.js';
import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;

/**
 * 检测是否为二进制文件
 */
async function isBinaryFile(filepath: string): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase();

  // 常见二进制文件扩展名
  const binaryExts = [
    '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.class', '.jar', '.war',
    '.7z', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
    '.ods', '.odp', '.bin', '.dat', '.obj', '.o', '.a', '.lib', '.wasm',
    '.pyc', '.pyo'
  ];

  if (binaryExts.includes(ext)) {
    return true;
  }

  try {
    const content = await readFile(filepath, { encoding: null });
    if (content.length === 0) return false;

    const bufferSize = Math.min(4096, content.length);
    const bytes = content.subarray(0, bufferSize);

    let nonPrintableCount = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) return true;
      if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
        nonPrintableCount++;
      }
    }

    // 如果 >30% 不可打印字符，认为是二进制
    return nonPrintableCount / bytes.length > 0.3;
  } catch {
    return false;
  }
}

/**
 * 文件读取工具
 */
export const readTool = createTool({
  name: 'read',
  description: 'Read a file from the local filesystem. Can read files with offset/limit for pagination, and can also read directory contents. For large files, use offset and limit parameters to read in chunks.',
  render: 'read',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'The absolute path to the file or directory to read'
      },
      offset: {
        type: 'number',
        description: 'The line number to start reading from (1-indexed, defaults to 1)'
      },
      limit: {
        type: 'number',
        description: 'The maximum number of lines to read (defaults to 2000)'
      }
    },
    required: ['filePath']
  },
  execute: async ({ filePath, offset: offsetParam, limit: limitParam }) => {
    console.log(`[read] ${filePath}`);

    if (offsetParam !== undefined && offsetParam < 1) {
      throw new Error('offset must be greater than or equal to 1');
    }

    const stats = await stat(filePath).catch(() => null);
    if (!stats) {
      throw new Error(`File not found: ${filePath}`);
    }

    // 处理目录
    if (stats.isDirectory()) {
      const dirents = await readdir(filePath, { withFileTypes: true });
      const entries: string[] = [];

      for (const dirent of dirents) {
        if (dirent.isDirectory()) {
          entries.push(dirent.name + path.sep);
        } else if (dirent.isSymbolicLink()) {
          try {
            const targetStats = await stat(path.join(filePath, dirent.name));
            entries.push(targetStats.isDirectory() ? dirent.name + path.sep : dirent.name);
          } catch {
            entries.push(dirent.name);
          }
        } else {
          entries.push(dirent.name);
        }
      }

      entries.sort((a, b) => a.localeCompare(b));

      const limit = limitParam ?? DEFAULT_READ_LIMIT;
      const offset = offsetParam ?? 1;
      const start = offset - 1;
      const sliced = entries.slice(start, start + limit);
      const truncated = start + sliced.length < entries.length;

      return {
        type: 'directory',
        path: filePath,
        totalEntries: entries.length,
        offset,
        limit,
        truncated,
        entries: sliced
      };
    }

    // 处理文件
    const isBinary = await isBinaryFile(filePath);
    if (isBinary) {
      throw new Error(`Cannot read binary file: ${filePath}`);
    }

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    const limit = limitParam ?? DEFAULT_READ_LIMIT;
    const offset = offsetParam ?? 1;
    const start = offset - 1;

    if (start >= lines.length) {
      throw new Error(`Offset ${offset} is out of range for this file (${lines.length} lines)`);
    }

    // 读取并处理行
    const raw: string[] = [];
    let bytes = 0;
    let truncatedByBytes = false;

    for (let i = start; i < Math.min(lines.length, start + limit); i++) {
      const line = lines[i].length > MAX_LINE_LENGTH
        ? lines[i].substring(0, MAX_LINE_LENGTH) + '...'
        : lines[i];
      const size = Buffer.byteLength(line, 'utf-8') + (raw.length > 0 ? 1 : 0);

      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true;
        break;
      }

      raw.push(line);
      bytes += size;
    }

    // 生成带行号的输出
    const contentWithLines = raw.map((line, index) => {
      return `${index + offset}: ${line}`;
    });

    const totalLines = lines.length;
    const lastReadLine = offset + raw.length - 1;
    const hasMoreLines = totalLines > lastReadLine;
    const truncated = hasMoreLines || truncatedByBytes;

    return {
      type: 'file',
      path: filePath,
      totalLines,
      offset,
      limit,
      truncated,
      truncatedByBytes,
      lastReadLine,
      content: contentWithLines.join('\n')
    };
  }
});
