/**
 * read_image 内容快照语义测试
 *
 * 从原 src/test/__tests__/tool-image-injection.test.ts 拆出：
 * 工具在调用时刻读取的字节必须与源文件后续变化隔离。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadImageTool } from '../src/tools.js';
import { isWithImagesResult } from '@agentdev/core';

describe('read_image managed snapshots', () => {
  it('should preserve the bytes read at tool-call time after the source changes or moves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdev-read-image-'));
    try {
      const workspaceDir = join(root, 'workspace');
      const storageDir = join(root, 'images');
      const sourcePath = join(root, 'source.png');
      const movedPath = join(root, 'moved.png');
      const original = Buffer.from('original-image-bytes');
      const replacement = Buffer.from('replacement-image-bytes');
      writeFileSync(sourcePath, original);

      const tool = createReadImageTool({ workspaceDir, storageDir });
      const result = await tool.execute({ path: sourcePath }, {} as any) as any;
      expect(isWithImagesResult(result)).toBe(true);
      const snapshotPath = result.images[0].path as string;
      expect(snapshotPath).not.toBe(sourcePath);
      expect(snapshotPath.startsWith(storageDir)).toBe(true);
      expect(readFileSync(snapshotPath).equals(original)).toBe(true);

      writeFileSync(sourcePath, replacement);
      renameSync(sourcePath, movedPath);

      expect(readFileSync(snapshotPath).equals(original)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should deduplicate identical content into one managed snapshot path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdev-read-image-dedup-'));
    try {
      const storageDir = join(root, 'images');
      const firstPath = join(root, 'first.png');
      const secondPath = join(root, 'second.png');
      const bytes = Buffer.from('same-image-bytes');
      writeFileSync(firstPath, bytes);
      writeFileSync(secondPath, bytes);

      const tool = createReadImageTool({ storageDir });
      const first = await tool.execute({ path: firstPath }, {} as any) as any;
      const second = await tool.execute({ path: secondPath }, {} as any) as any;

      expect(first.images[0].path).toBe(second.images[0].path);
      expect(first.images[0].source).toBe(firstPath);
      expect(second.images[0].source).toBe(secondPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
