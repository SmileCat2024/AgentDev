import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createEditTool, createReadTool } from '../tools.js';

describe('edit tool guard removal and CRLF tolerance', () => {
  it('edits a file that was never read in this session', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-edit-'));
    const target = join(workspaceDir, 'unread.txt');
    await writeFile(target, 'alpha\nbeta\n', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      await editTool.execute({ filePath: 'unread.txt', oldString: 'beta', newString: 'gamma' });
      const updated = await readFile(target, 'utf8');
      expect(updated).toBe('alpha\ngamma\n');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('edits a file modified externally after the last read (staleness guard removed)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-edit-'));
    const target = join(workspaceDir, 'stale.txt');
    await writeFile(target, 'one\ntwo\n', 'utf8');
    const readTool = createReadTool(workspaceDir);
    const editTool = createEditTool(workspaceDir);
    try {
      await readTool.execute({ filePath: 'stale.txt' });
      await writeFile(target, 'one\ntwo\nthree\n', 'utf8'); // 外部修改，mtime 变化
      await editTool.execute({ filePath: 'stale.txt', oldString: 'three', newString: 'THREE' });
      const updated = await readFile(target, 'utf8');
      expect(updated).toBe('one\ntwo\nTHREE\n');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('matches oldString containing \\r\\n against a CRLF file and preserves CRLF on write', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-edit-'));
    const target = join(workspaceDir, 'crlf.txt');
    await writeFile(target, 'first\r\nsecond\r\n', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      // 模型从 read 输出复制 oldString 时常带上 \r 残留
      await editTool.execute({ filePath: 'crlf.txt', oldString: 'first\r\nsecond', newString: 'first\r\nSECOND' });
      const buf = await readFile(target);
      expect(buf.toString('utf8')).toBe('first\r\nSECOND\r\n');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('matches \\n oldString against a lone-\\r file', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-edit-'));
    const target = join(workspaceDir, 'cr-only.txt');
    await writeFile(target, 'first\rsecond\r', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      await editTool.execute({ filePath: 'cr-only.txt', oldString: 'second', newString: 'SECOND' });
      const updated = await readFile(target, 'utf8');
      expect(updated).toBe('first\nSECOND\n'); // 孤立 \r 归一为 LF（无 \r\n 样本可还原）
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('treats old/new strings differing only in line endings as identical', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-edit-'));
    const target = join(workspaceDir, 'noop.txt');
    await writeFile(target, 'same\n', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      await expect(
        editTool.execute({ filePath: 'noop.txt', oldString: 'a\r\nb', newString: 'a\nb' }),
      ).rejects.toThrow('identical');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
