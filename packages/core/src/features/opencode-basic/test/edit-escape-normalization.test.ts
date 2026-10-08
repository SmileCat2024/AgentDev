import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createEditTool } from '../tools.js';

const parseResult = (r: unknown): { message?: string; warning?: string } => {
  const raw = typeof r === 'string' ? r : ((r as { text?: string }).text ?? '{}');
  return JSON.parse(raw);
};

describe('edit tool escape-mismatch pre-probe', () => {
  it('unescapes both oldString and newString when the escaped form matches the file uniquely', async () => {
    // 文件里是真实引号；模型 oldString/newString 携带字面反斜杠引号（抄自 JSON 序列化形态）
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-esc-'));
    const target = join(workspaceDir, 'plain.txt');
    await writeFile(target, 'alpha "quoted" beta\n', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      const r = parseResult(
        await editTool.execute({
          filePath: 'plain.txt',
          oldString: 'alpha \\"quoted\\" beta',
          newString: 'alpha \\"QUOTED\\" beta',
        }),
      );
      const updated = await readFile(target, 'utf8');
      // newString 同构反转义：写入干净引号，无字面反斜杠（旧实现原样写入会污染文件）
      expect(updated).toBe('alpha "QUOTED" beta\n');
      expect(r.warning).toContain('normalization');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('does not auto-normalize when the unescaped form matches multiple locations', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-esc-'));
    const target = join(workspaceDir, 'dup.txt');
    await writeFile(target, 'x "dup" y\nz "dup" w\n', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      await expect(
        editTool.execute({ filePath: 'dup.txt', oldString: '\\"dup\\"', newString: '\\"DUP\\"' }),
      ).rejects.toThrow(/Could not find/);
      // 多处命中不自动归一，文件保持原样
      expect(await readFile(target, 'utf8')).toBe('x "dup" y\nz "dup" w\n');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('exact match on literal escape sequences stays untouched (no normalization)', async () => {
    // 文件里就是字面反斜杠序列（正则字面量）；oldString 精确提供字面序列
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-esc-'));
    const target = join(workspaceDir, 'regex.js');
    await writeFile(target, 'const re = /a\\nb/;\n', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      const r = parseResult(
        await editTool.execute({ filePath: 'regex.js', oldString: 'a\\nb', newString: 'a\\tb' }),
      );
      const updated = await readFile(target, 'utf8');
      // 字面序列原样写入，未触发归一
      expect(updated).toBe('const re = /a\\tb/;\n');
      expect(r.warning).toBeUndefined();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('normalizes and replaces all occurrences when replaceAll is set', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-esc-'));
    const target = join(workspaceDir, 'all.txt');
    await writeFile(target, 'x "a" y\nx "a" z\n', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      const r = parseResult(
        await editTool.execute({
          filePath: 'all.txt',
          oldString: '\\"a\\"',
          newString: '\\"b\\"',
          replaceAll: true,
        }),
      );
      expect(await readFile(target, 'utf8')).toBe('x "b" y\nx "b" z\n');
      expect(r.warning).toContain('normalization');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('applies the pre-probe to indentation-sensitive files (py)', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-esc-'));
    const target = join(workspaceDir, 'foo.py');
    await writeFile(target, "s = 'py-str'\n", 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      await editTool.execute({
        filePath: 'foo.py',
        oldString: "s = \\'py-str\\'",
        newString: "s = \\'PY-STR\\'",
      });
      expect(await readFile(target, 'utf8')).toBe("s = 'PY-STR'\n");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('real-character oldString no longer fuzzy-matches literal sequences in the file (strategy B removed)', async () => {
    // 文件里是字面 backslash-n；oldString 提供真实换行。旧策略 B 会把文件块
    // 反转义后模糊命中；现行实现显式报错，引导模型重读后按文件真实文本重试。
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agentdev-esc-'));
    const target = join(workspaceDir, 'literal.js');
    await writeFile(target, 'const s = "foo\\nbar";\n', 'utf8');
    const editTool = createEditTool(workspaceDir);
    try {
      await expect(
        editTool.execute({ filePath: 'literal.js', oldString: 'foo\nbar', newString: 'foo\nBAR' }),
      ).rejects.toThrow(/Could not find/);
      expect(await readFile(target, 'utf8')).toBe('const s = "foo\\nbar";\n');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
