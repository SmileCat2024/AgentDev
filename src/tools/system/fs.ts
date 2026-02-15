import { readFile, writeFile, readdir } from 'fs/promises';
import { createTool } from '../../core/tool.js';

// 文件读取
export const readFileTool = createTool({
  name: 'read_file',
  description: '读取文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  execute: async ({ path }) => {
    console.log(`[read_file] ${path}`);
    return await readFile(path, 'utf-8');
  },
});

// 文件写入
export const writeFileTool = createTool({
  name: 'write_file',
  description: '写入文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  execute: async ({ path, content }) => {
    console.log(`[write_file] ${path}`);
    await writeFile(path, content, 'utf-8');
    return `文件已写入: ${path}`;
  },
});

// 列出目录
export const listDirTool = createTool({
  name: 'list_directory',
  description: '列出目录内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  execute: async ({ path }) => {
    console.log(`[list_directory] ${path}`);
    const files = await readdir(path);
    return files.join('\n');
  },
});
