/**
 * read/write 路径解析发散的调用改写测试（ADR-0023 确定性纠正类）
 *
 * 覆盖：
 * - 相对路径 + callId → withRewrite 生效调用（绝对路径、别名键剔除）
 * - 绝对路径常态 → 不触发（read 裸对象 / write withDisplay）
 * - 无 callId（直接调用）→ 不触发
 * - write 发散时 display 通道仍携带 diff
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'fs/promises';
import { join, normalize } from 'path';
import { tmpdir } from 'os';
import { createReadTool, createWriteTool } from '../tools.js';
import { isWithRewriteResult } from '../../../core/tool-call-rewrite.js';
import { isWithDisplayResult } from '../../../core/tool-result-display.js';

describe('read/write path resolution rewrite (ADR-0023)', () => {
  it('read: 相对路径 + callId → 生效调用携带绝对路径', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-rewrite-'));
    await writeFile(join(workspaceDir, 'a.txt'), 'hello\nworld\n', 'utf8');
    const readTool = createReadTool(workspaceDir);
    try {
      const result = await readTool.execute(
        { filePath: 'a.txt' },
        { callId: 'tc_read_1' },
      ) as ReturnType<typeof isWithRewriteResult> extends true ? never : unknown;

      expect(isWithRewriteResult(result)).toBe(true);
      const rw = result as { text: string; effectiveCall: { id: string; name: string; arguments: Record<string, unknown> } };
      expect(rw.effectiveCall.id).toBe('tc_read_1');
      expect(rw.effectiveCall.name).toBe('read');
      expect(rw.effectiveCall.arguments.filePath).toBe(normalize(join(workspaceDir, 'a.txt')));
      // 别名键不进入生效参数
      expect(rw.effectiveCall.arguments.filepath).toBeUndefined();
      expect(rw.effectiveCall.arguments.path).toBeUndefined();
      // text 与原返回对象的 JSON 序列化一致（模型侧内容无变化）
      const parsed = JSON.parse(rw.text);
      expect(parsed.type).toBe('file');
      expect(parsed.content).toContain('hello');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('read: 参数别名 filepath 且带 offset → 生效参数规范为 filePath 并保留 offset', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-rewrite-'));
    await writeFile(join(workspaceDir, 'b.txt'), 'l1\nl2\nl3\n', 'utf8');
    const readTool = createReadTool(workspaceDir);
    try {
      const result = await readTool.execute(
        { filepath: 'b.txt', offset: 2 } as Record<string, unknown>,
        { callId: 'tc_read_2' },
      );
      expect(isWithRewriteResult(result)).toBe(true);
      const rw = result as { effectiveCall: { arguments: Record<string, unknown> } };
      expect(rw.effectiveCall.arguments.filePath).toBe(normalize(join(workspaceDir, 'b.txt')));
      expect(rw.effectiveCall.arguments.offset).toBe(2);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('read: 绝对路径常态 → 裸对象返回，不触发改写', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-rewrite-'));
    const abs = join(workspaceDir, 'c.txt');
    await writeFile(abs, 'abs\n', 'utf8');
    const readTool = createReadTool(workspaceDir);
    try {
      const result = await readTool.execute(
        { filePath: abs },
        { callId: 'tc_read_3' },
      ) as Record<string, unknown>;
      expect(isWithRewriteResult(result)).toBe(false);
      expect(result.type).toBe('file');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('read: 相对路径但无 callId（直接调用）→ 不触发改写', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-rewrite-'));
    await writeFile(join(workspaceDir, 'd.txt'), 'x\n', 'utf8');
    const readTool = createReadTool(workspaceDir);
    try {
      const result = await readTool.execute({ filePath: 'd.txt' }) as Record<string, unknown>;
      expect(isWithRewriteResult(result)).toBe(false);
      expect(result.type).toBe('file');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('read: 目录相对路径 → 生效调用（目录分支同样包装）', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-rewrite-'));
    const readTool = createReadTool(workspaceDir);
    try {
      const result = await readTool.execute(
        { filePath: '.' },
        { callId: 'tc_read_4' },
      );
      expect(isWithRewriteResult(result)).toBe(true);
      const rw = result as { effectiveCall: { arguments: Record<string, unknown> }; text: string };
      expect(rw.effectiveCall.arguments.filePath).toBe(normalize(workspaceDir));
      expect(JSON.parse(rw.text).type).toBe('directory');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('write: 相对路径 + callId → 生效调用携带绝对路径，display 保留', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-rewrite-'));
    const writeTool = createWriteTool(workspaceDir);
    try {
      const result = await writeTool.execute(
        { filePath: 'new.txt', content: 'data\n' },
        { callId: 'tc_write_1' },
      );
      expect(isWithRewriteResult(result)).toBe(true);
      const rw = result as {
        text: string;
        effectiveCall: { id: string; name: string; arguments: Record<string, unknown> };
        display: { filePath: string; diff: string };
      };
      expect(rw.effectiveCall.id).toBe('tc_write_1');
      expect(rw.effectiveCall.name).toBe('write');
      expect(rw.effectiveCall.arguments.filePath).toBe(normalize(join(workspaceDir, 'new.txt')));
      expect(rw.effectiveCall.arguments.content).toBe('data\n');
      // display 通道照常携带（前端徽章 + diff）
      expect(rw.display.filePath).toBe(normalize(join(workspaceDir, 'new.txt')));
      expect(rw.display.diff).toBeTruthy();
      expect(JSON.parse(rw.text).message).toContain('created');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('write: 绝对路径常态 → withDisplay 形态，不触发改写', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-rewrite-'));
    const abs = join(workspaceDir, 'plain.txt');
    const writeTool = createWriteTool(workspaceDir);
    try {
      const result = await writeTool.execute(
        { filePath: abs, content: 'plain\n' },
        { callId: 'tc_write_2' },
      );
      expect(isWithRewriteResult(result)).toBe(false);
      expect(isWithDisplayResult(result)).toBe(true);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe('write no-path content fallback', () => {
  it('filePath 空串 → 内容落 .agentdev/temp 并返回迁移指引', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-fallback-'));
    const writeTool = createWriteTool(workspaceDir);
    try {
      const result = await writeTool.execute(
        { filePath: '', content: 'rescued content\n' } as Record<string, unknown>,
        { callId: 'tc_fb_1' },
      );
      expect(typeof result).toBe('string');
      expect(result as string).toContain('.agentdev');
      expect(result as string).toContain('not discarded');
      // 临时文件真实存在且内容一致
      const tempDir = join(workspaceDir, '.agentdev', 'temp');
      const files = await readdir(tempDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^write-\d+-[a-z0-9]+\.txt$/);
      const saved = await readFile(join(tempDir, files[0]), 'utf8');
      expect(saved).toBe('rescued content\n');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('filePath 纯白与路径键缺失 → 同样兜底；null byte 仍安全拦截', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-fallback-'));
    const writeTool = createWriteTool(workspaceDir);
    try {
      const blank = await writeTool.execute(
        { filePath: '   ', content: 'x\n' } as Record<string, unknown>,
      );
      expect(blank as string).toContain('.agentdev');

      const missing = await writeTool.execute(
        { content: 'y\n' } as Record<string, unknown>,
      );
      expect(missing as string).toContain('.agentdev');

      // 路径含 null byte 是安全拦截，不属于废值兜底
      await expect(
        writeTool.execute({ filePath: 'a\0b', content: 'z\n' } as Record<string, unknown>),
      ).rejects.toThrow(/null bytes/);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
