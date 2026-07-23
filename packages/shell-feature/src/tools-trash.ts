/**
 * Safe Trash 工具定义
 */

import { join } from 'path';
import { createTool } from 'agentdev';
import type { Tool } from 'agentdev';
import { safeRm, listTrashed, restore } from './lib/index.js';

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
    description: '安全删除文件或目录，移动到垃圾目录而非永久删除。',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        trashDir: { type: 'string' },
      },
      required: ['paths'],
    },
    render: { call: 'trash-delete', result: 'trash-delete' },
    execute: async (args) => {
      const { paths, trashDir } = args as { paths: string[]; trashDir?: string };
      const trashDirPath = trashDir || defaultTrashDir;
      const result = safeRm(workspaceDir, paths.join(' '), trashDirPath, null, 0);
      return {
        success: result.success,
        moved_count: result.movedCount,
        moved: result.moved,
        failed: result.failed,
      };
    },
  });
}

export function createSafeTrashListTool(workspaceDir: string = process.cwd()): Tool {
  const defaultTrashDir = join(workspaceDir, '.trash');
  return createTool({
    name: 'safe_trash_list',
    description: '列出垃圾目录中的所有可恢复文件。',
    parallelizable: true,
    parameters: {
      type: 'object',
      properties: {
        trashDir: { type: 'string' },
      },
    },
    render: { call: 'trash-list', result: 'trash-list' },
    execute: async (args) => {
      const { trashDir } = args as { trashDir?: string };
      const trashDirPath = trashDir || defaultTrashDir;
      const result = listTrashed(trashDirPath, null);
      return {
        success: result.success,
        total: result.total,
        files: result.files.map((f) => ({ ...f, size_formatted: formatSize(f.size || 0) })),
      };
    },
  });
}

export function createSafeTrashRestoreTool(workspaceDir: string = process.cwd()): Tool {
  const defaultTrashDir = join(workspaceDir, '.trash');
  return createTool({
    name: 'safe_trash_restore',
    description: '从垃圾目录恢复文件到原位置。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } }],
        },
        trashDir: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['target'],
    },
    render: { call: 'trash-restore', result: 'trash-restore' },
    execute: async (args) => {
      const { target, trashDir, overwrite } = args as { target: number | string | number[] | string[]; trashDir?: string; overwrite?: boolean };
      const trashDirPath = trashDir || defaultTrashDir;
      const result = restore(trashDirPath, target, null, overwrite || false, false, true);
      return {
        success: result.success,
        restored_count: result.restoredCount,
        restored: result.restored,
        failed: result.failed,
      };
    },
  });
}

export const safeTrashDeleteTool = createSafeTrashDeleteTool();
export const safeTrashListTool = createSafeTrashListTool();
export const safeTrashRestoreTool = createSafeTrashRestoreTool();
