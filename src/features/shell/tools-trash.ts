/**
 * Safe Trash 工具定义
 *
 * 提供安全删除、列表和恢复工具，使用原生 TypeScript 实现
 */

import { join } from 'path';
import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import { safeRm, listTrashed, restore } from './lib/index.js';

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function createSafeTrashDeleteTool(workspaceDir: string = process.cwd()): Tool {
  const defaultTrashDir = join(workspaceDir, '.trash');
  return createTool({
    name: 'safe_trash_delete',
    description: `安全删除文件或目录，移动到垃圾目录而非永久删除。

此工具将文件移动到垃圾目录（类似回收站），文件可以稍后恢复。支持删除单个文件、多个文件或整个目录树。

**重要注意事项：**
⚠️ 路径包含空格时必须使用引号包裹！例如: {"paths": ["file with spaces.txt"]}
⚠️ 系统文件（如 C:\\Windows、C:\\Program Files）受保护，无法删除
⚠️ 恢复时如目标位置已存在同名文件，需指定 overwrite=true

**用法示例：**
- 删除单个文件: {"paths": ["file.txt"]}
- 删除空格文件名（必须用引号）: {"paths": ["my document.txt"]}
- 删除多个文件: {"paths": ["file1.txt", "file2.txt"]}
- 删除目录: {"paths": ["./my-folder"]}
- 删除绝对路径: {"paths": ["C:\\\\Users\\\\username\\\\Desktop\\\\temp.txt"]}
- 混合路径: {"paths": ["file.txt", "./data/", "C:\\\\temp\\\\test.txt"]}`,
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要删除的文件或目录路径列表。',
        },
        trashDir: {
          type: 'string',
          description: '垃圾目录路径（可选）。',
        },
      },
      required: ['paths'],
    },
    render: { call: 'trash-delete', result: 'trash-delete' },
    execute: async (args) => {
      const { paths, trashDir } = args as { paths: string[]; trashDir?: string };
      const trashDirPath = trashDir || defaultTrashDir;
      console.log(`[safe_trash_delete] Moving ${paths.length} item(s) to ${trashDirPath}`);

      try {
        const result = safeRm(
          workspaceDir,
          paths.join(' '),
          trashDirPath,
          null,
          0
        );

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
}

export function createSafeTrashListTool(workspaceDir: string = process.cwd()): Tool {
  const defaultTrashDir = join(workspaceDir, '.trash');
  return createTool({
    name: 'safe_trash_list',
    description: `列出垃圾目录中的所有可恢复文件。`,
    parallelizable: true,
    parameters: {
      type: 'object',
      properties: {
        trashDir: {
          type: 'string',
          description: '垃圾目录路径（可选）。',
        },
      },
    },
    render: { call: 'trash-list', result: 'trash-list' },
    execute: async (args) => {
      const { trashDir } = args as { trashDir?: string };
      const trashDirPath = trashDir || defaultTrashDir;
      console.log(`[safe_trash_list] Listing ${trashDirPath}`);

      try {
        const result = listTrashed(trashDirPath, null);
        const files = result.files.map((f) => ({
          ...f,
          size_formatted: formatSize(f.size || 0),
        }));

        return {
          success: result.success,
          total: result.total,
          files,
        };
      } catch (error) {
        throw new Error(`List trash failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

export function createSafeTrashRestoreTool(workspaceDir: string = process.cwd()): Tool {
  const defaultTrashDir = join(workspaceDir, '.trash');
  return createTool({
    name: 'safe_trash_restore',
    description: `从垃圾目录恢复文件到原位置。`,
    parameters: {
      type: 'object',
      properties: {
        target: {
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } }],
          description: '要恢复的目标。',
        },
        trashDir: {
          type: 'string',
          description: '垃圾目录路径（可选）。',
        },
        overwrite: {
          type: 'boolean',
          description: '是否覆盖已存在的文件（默认 false）。',
        },
      },
      required: ['target'],
    },
    render: { call: 'trash-restore', result: 'trash-restore' },
    execute: async (args) => {
      const { target, trashDir, overwrite } = args as { target: string | number | Array<string | number>; trashDir?: string; overwrite?: boolean };
      const trashDirPath = trashDir || defaultTrashDir;
      console.log(`[safe_trash_restore] Restoring ${target} from ${trashDirPath}`);

      try {
        const result = restore(
          trashDirPath,
          target,
          null,
          overwrite || false,
          false,
          true
        );

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
}

export const safeTrashDeleteTool = createSafeTrashDeleteTool();
export const safeTrashListTool = createSafeTrashListTool();
export const safeTrashRestoreTool = createSafeTrashRestoreTool();
