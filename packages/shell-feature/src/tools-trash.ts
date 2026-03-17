/**
 * Safe Trash 工具定义
 */

import { join } from 'path';
import { cwd } from 'process';
import { createTool } from 'agentdev';
import type { Tool } from 'agentdev';
import { safeRm, listTrashed, restore } from './lib/index.js';

const DEFAULT_TRASH_DIR = join(cwd(), '.trash');

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export const safeTrashDeleteTool: Tool = createTool({
  name: 'safe_trash_delete',
  description: `安全删除文件或目录，移动到垃圾目录而非永久删除。

此工具将文件移动到垃圾目录（类似回收站），文件可以稍后恢复。

**重要事项：**
⚠️ 路径包含空格时必须使用引号包裹
⚠️ 系统文件受保护，无法删除

**用法示例：**
- 删除单个文件: {"paths": ["file.txt"]}
- 删除多个文件: {"paths": ["file1.txt", "file2.txt"]}
- 删除目录: {"paths": ["./my-folder"]}`,

  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '要删除的文件或目录路径列表',
      },
      trashDir: {
        type: 'string',
        description: '垃圾目录路径（可选，默认 .trash）',
      },
    },
    required: ['paths'],
  },
  render: { call: 'trash-delete', result: 'trash-delete' },
  execute: async ({ paths, trashDir }) => {
    const trashDirPath = trashDir || DEFAULT_TRASH_DIR;
    console.log(`[safe_trash_delete] Moving ${paths.length} item(s) to ${trashDirPath}`);
    try {
      const result = safeRm(null, paths.join(' '), trashDirPath, null, 0);
      return {
        success: result.success,
        moved_count: result.movedCount,
        moved: result.moved,
        failed: result.failed,
      };
    } catch (error) {
      throw new Error(`Safe delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const safeTrashListTool: Tool = createTool({
  name: 'safe_trash_list',
  description: `列出垃圾目录中的所有可恢复文件。

显示所有已删除文件的列表，包括原始路径、删除时间、文件大小等信息。`,

  parameters: {
    type: 'object',
    properties: {
      trashDir: {
        type: 'string',
        description: '垃圾目录路径（可选，默认 .trash）',
      },
    },
  },
  render: { call: 'trash-list', result: 'trash-list' },
  execute: async ({ trashDir }) => {
    const trashDirPath = trashDir || DEFAULT_TRASH_DIR;
    console.log(`[safe_trash_list] Listing ${trashDirPath}`);
    try {
      const result = listTrashed(trashDirPath, null);
      const files = result.files.map((f) => ({
        ...f,
        size_formatted: formatSize(f.size || 0),
      }));
      return { success: result.success, total: result.total, files };
    } catch (error) {
      throw new Error(`List trash failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const safeTrashRestoreTool: Tool = createTool({
  name: 'safe_trash_restore',
  description: `从垃圾目录恢复文件到原位置。

支持按索引恢复、按路径模式恢复（支持通配符）或按索引范围恢复。

**恢复方式：**
- 按索引: {"target": 0}
- 按路径模式: {"target": "*.txt"}
- 按索引范围: {"target": "0-5"}`,

  parameters: {
    type: 'object',
    properties: {
      target: {
        oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } }],
        description: '要恢复的目标（索引或路径模式）',
      },
      trashDir: {
        type: 'string',
        description: '垃圾目录路径（可选，默认 .trash）',
      },
      overwrite: {
        type: 'boolean',
        description: '是否覆盖已存在的文件（默认 false）',
      },
    },
    required: ['target'],
  },
  render: { call: 'trash-restore', result: 'trash-restore' },
  execute: async ({ target, trashDir, overwrite }) => {
    const trashDirPath = trashDir || DEFAULT_TRASH_DIR;
    console.log(`[safe_trash_restore] Restoring ${target} from ${trashDirPath}`);
    try {
      const result = restore(trashDirPath, target, null, overwrite || false, false, true);
      return {
        success: result.success,
        restored_count: result.restoredCount,
        restored: result.restored,
        failed: result.failed,
      };
    } catch (error) {
      throw new Error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
