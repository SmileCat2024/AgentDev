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
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
