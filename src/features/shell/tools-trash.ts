/**
 * Safe Trash 工具定义
 *
 * 提供安全删除、列表和恢复工具，使用原生 TypeScript 实现
 */

import { join } from 'path';
import { cwd } from 'process';
import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import { safeRm, listTrashed, restore } from './lib/index.js';

// 默认垃圾目录
const DEFAULT_TRASH_DIR = join(cwd(), '.trash');

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

/**
 * safe_trash_delete 工具
 */
export const safeTrashDeleteTool: Tool = createTool({
  name: 'safe_trash_delete',
  description: '安全删除文件或目录，移动到垃圾目录而非永久删除',
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
        description: '垃圾目录路径（可选，默认为项目根目录下的 .trash）',
      },
    },
    required: ['paths'],
  },
  render: { call: 'trash-delete', result: 'trash-delete' },
  execute: async ({ paths, trashDir }) => {
    const trashDirPath = trashDir || DEFAULT_TRASH_DIR;
    console.log(`[safe_trash_delete] Moving ${paths.length} item(s) to ${trashDirPath}`);

    try {
      const result = safeRm(
        null,
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

/**
 * safe_trash_list 工具
 */
export const safeTrashListTool: Tool = createTool({
  name: 'safe_trash_list',
  description: '列出垃圾目录中的所有可恢复文件',
  parameters: {
    type: 'object',
    properties: {
      trashDir: {
        type: 'string',
        description: '垃圾目录路径（可选，默认为项目根目录下的 .trash）',
      },
    },
  },
  render: { call: 'trash-list', result: 'trash-list' },
  execute: async ({ trashDir }) => {
    const trashDirPath = trashDir || DEFAULT_TRASH_DIR;
    console.log(`[safe_trash_list] Listing ${trashDirPath}`);

    try {
      const result = listTrashed(trashDirPath, null);

      // 格式化文件大小
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

/**
 * safe_trash_restore 工具
 */
export const safeTrashRestoreTool: Tool = createTool({
  name: 'safe_trash_restore',
  description: '从垃圾目录恢复文件到原位置',
  parameters: {
    type: 'object',
    properties: {
      target: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
        description: '要恢复的目标：索引（数字）或路径模式（字符串，支持通配符 *?）',
      },
      trashDir: {
        type: 'string',
        description: '垃圾目录路径（可选，默认为项目根目录下的 .trash）',
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
