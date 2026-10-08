import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Decision } from '../../../core/lifecycle.js';
import { createEditTool, createWriteTool } from '../tools.js';
import { OpencodeBasicFeature } from '../index.js';

describe('OpencodeBasic path argument compatibility', () => {
  it('should accept both path and filepath aliases for write and edit', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-opencode-'));
    const targetFile = join(workspaceDir, 'sample.txt');
    const writeTool = createWriteTool(workspaceDir);
    const editTool = createEditTool(workspaceDir);
    const feature = new OpencodeBasicFeature({ workspaceDir });

    try {
      await writeTool.execute({ path: 'sample.txt', content: 'hello' });
      const created = await readFile(targetFile, 'utf8');
      expect(created).toBe('hello');

      await editTool.execute({ filepath: 'sample.txt', oldString: 'hello', newString: 'world' });
      const updated = await readFile(targetFile, 'utf8');
      expect(updated).toBe('world');

      await expect(writeTool.execute({})).rejects.toThrow('Missing required parameter: "filePath"');

      await feature.onInitiate({ logger: { info() {}, warn() {} } } as any);
      const readDecision = await feature.validateWriteOperation({
        call: { id: 'read_alias', name: 'read', arguments: { path: 'sample.txt' } },
      } as any);
      expect(readDecision).toBe(Decision.Continue);

      const writeDecision = await feature.validateWriteOperation({
        call: { id: 'write_alias', name: 'write', arguments: { filepath: 'sample.txt' } },
      } as any);
      expect(writeDecision).toBe(Decision.Continue);

      // edit 不经读前置闸门（盲改防护撤除）：未读过的文件也放行
      const editDecision = await feature.validateWriteOperation({
        call: { id: 'edit_unread', name: 'edit', arguments: { filePath: 'never-read.txt' } },
      } as any);
      expect(editDecision).toBe(Decision.Continue);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('should pass through hooks when path is missing or blank (no noise, execute handles it)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-opencode-'));
    const feature = new OpencodeBasicFeature({ workspaceDir });

    try {
      await feature.onInitiate({ logger: { info() {}, warn() {} } } as any);

      // read：无路径无文件可跟踪，放行；缺参报错由 read 自身给出
      const readBlank = await feature.validateWriteOperation({
        call: { id: 'read_blank', name: 'read', arguments: { filePath: '   ' } },
      } as any);
      expect(readBlank).toBe(Decision.Continue);

      // write：无路径无"已存在文件"可查，闸门无职责放行；
      // 兜底（.agentdev/temp 落盘）由 write 的 execute 承担
      const writeBlank = await feature.validateWriteOperation({
        call: { id: 'write_blank', name: 'write', arguments: { filePath: '' } },
      } as any);
      expect(writeBlank).toBe(Decision.Continue);

      const writeMissing = await feature.validateWriteOperation({
        call: { id: 'write_missing', name: 'write', arguments: {} },
      } as any);
      expect(writeMissing).toBe(Decision.Continue);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
