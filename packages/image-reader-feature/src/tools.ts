/**
 * read_image 工具
 *
 * 读取本地图片文件，通过 withImages() 将图片注入到对话上下文中。
 * 支持常见图片格式：PNG、JPEG、GIF、WebP、BMP。
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createTool, withImages } from '@agentdev/core';
import type { Tool } from '@agentdev/core';

/** 扩展名 → MIME 类型映射 */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/** 支持的扩展名列表（用于错误提示） */
const SUPPORTED_EXTS = Object.keys(MEDIA_TYPES);

/** 图片大小上限：10 MB */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export interface ReadImageToolOptions {
  /** 工作目录（用于解析相对路径） */
  workspaceDir?: string;
  /**
   * 受管图片目录。配置后，read_image 会在调用时把图片按内容哈希固化到此目录，
   * 后续上下文只引用该不可变快照，不再依赖原文件。
   */
  storageDir?: string;
}

export function createReadImageTool(options: ReadImageToolOptions = {}): Tool {
  const workspaceDir = options.workspaceDir;
  const storageDir = resolve(options.storageDir || join(homedir(), '.agentdev', 'images'));
  return createTool({
    name: 'read_image',
    parallelizable: true,
    description:
      '读取本地图片文件并注入到对话上下文中，使你能直接"看到"图片内容。' +
      '支持 PNG、JPEG、GIF、WebP、BMP、SVG 格式。' +
      '图片大小上限 10 MB。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '图片文件的路径（绝对路径或相对于工作目录的相对路径）',
        },
      },
      required: ['path'],
    },
    execute: async (args) => {
      const inputPath = String((args as Record<string, unknown>).path ?? '');
      if (!inputPath || typeof inputPath !== 'string') {
        return '错误：缺少 path 参数';
      }

      // 解析路径：绝对路径直接用，相对路径基于 workspaceDir
      const absPath = resolve(workspaceDir || process.cwd(), inputPath);

      // 检查文件是否存在
      if (!existsSync(absPath)) {
        return `错误：文件不存在: ${absPath}`;
      }

      // 检查是否为文件
      const stat = statSync(absPath);
      if (!stat.isFile()) {
        return `错误：路径不是文件: ${absPath}`;
      }

      // 检查文件大小
      if (stat.size > MAX_IMAGE_SIZE) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        return `错误：图片过大（${sizeMB} MB），上限为 10 MB`;
      }

      // 确定 MIME 类型
      const ext = absPath.toLowerCase().split('.').pop() || '';
      const mediaType = MEDIA_TYPES[ext];
      if (!mediaType) {
        return `错误：不支持的图片格式 .${ext}，支持的格式：${SUPPORTED_EXTS.map(e => '.' + e).join(', ')}`;
      }

      // 调用时固化内容快照：与 Claw 用户上传一致，使用 base64 内容哈希命名。
      // 消息只引用受管副本，因此原文件后续移动、删除或覆盖不会改变历史上下文。
      const data = readFileSync(absPath);
      const base64 = data.toString('base64');
      const hash = createHash('sha256').update(base64).digest('hex').slice(0, 32);
      const storageExt = mediaType === 'image/jpeg' ? 'jpg' : ext;
      const snapshotPath = resolve(storageDir, `${hash}.${storageExt}`);
      mkdirSync(storageDir, { recursive: true });
      if (!existsSync(snapshotPath) || !readFileSync(snapshotPath).equals(data)) {
        writeFileSync(snapshotPath, data);
      }

      return withImages(
        `已读取图片文件: ${absPath}（${(stat.size / 1024).toFixed(0)} KB, ${mediaType}）`,
        [{ path: snapshotPath, mediaType, source: absPath }],
      );
    },
  });
}
