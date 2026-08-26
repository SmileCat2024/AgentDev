import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGlobTool, createGrepTool, createLsTool, createReadTool } from '../tools.js';

describe('opencode-basic directory listing', () => {
  it('does not recurse through a large deep tree', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentdev-ls-'));
    try {
      await mkdir(join(workspace, 'src', 'deep', 'deeper'), { recursive: true });
      await writeFile(join(workspace, 'root.txt'), 'root');
      await writeFile(join(workspace, 'src', 'level-one.txt'), 'one');
      await writeFile(join(workspace, 'src', 'deep', 'level-two.txt'), 'two');
      await writeFile(join(workspace, 'src', 'deep', 'deeper', 'level-three.txt'), 'three');

      const result = await createLsTool(workspace).execute({ dirPath: workspace });

      expect(result.truncated).toBe(false);
      expect(result.tree).toContain('root.txt');
      expect(result.tree).toContain('level-one.txt');
      expect(result.tree).toContain('level-two.txt');
      expect(result.tree).not.toContain('level-three.txt');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('prunes ignored directories before descending', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentdev-ls-ignore-'));
    try {
      await mkdir(join(workspace, 'node_modules', 'package'), { recursive: true });
      await writeFile(join(workspace, 'node_modules', 'package', 'hidden.js'), 'hidden');
      await mkdir(join(workspace, 'src'));
      await writeFile(join(workspace, 'src', 'visible.ts'), 'visible');

      const result = await createLsTool(workspace).execute({ dirPath: workspace });

      expect(result.tree).not.toContain('node_modules');
      expect(result.tree).not.toContain('hidden.js');
      expect(result.tree).toContain('visible.ts');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('marks a directory as truncated without materializing every child', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentdev-ls-limit-'));
    try {
      await Promise.all(
        Array.from({ length: 130 }, (_, index) =>
          writeFile(join(workspace, `file-${String(index).padStart(3, '0')}.txt`), ''),
        ),
      );

      const result = await createLsTool(workspace).execute({ dirPath: workspace });

      expect(result.truncated).toBe(true);
      expect(result.count).toBe(100);
      expect(result.tree).toContain('… 30 more');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps directory pagination sorted while using a bounded candidate window', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentdev-read-dir-'));
    try {
      await Promise.all(
        ['z.txt', 'a.txt', 'm.txt', 'b.txt', 'y.txt'].map(name => writeFile(join(workspace, name), '')),
      );

      const result = await createReadTool(workspace).execute({ filePath: workspace, offset: 2, limit: 2 });

      expect(result.type).toBe('directory');
      expect(result.entries).toEqual(['b.txt', 'm.txt']);
      expect(result.totalEntries).toBe(5);
      expect(result.truncated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('bounds glob results at the tool limit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentdev-glob-limit-'));
    try {
      await Promise.all(
        Array.from({ length: 130 }, (_, index) =>
          writeFile(join(workspace, `file-${String(index).padStart(3, '0')}.txt`), ''),
        ),
      );

      const result = await createGlobTool(workspace).execute({ pattern: '**/*.txt', searchPath: workspace });

      expect(result.files).toHaveLength(100);
      expect(result.count).toBe(100);
      expect(result.truncated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('bounds grep results and terminates the search after the limit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentdev-grep-limit-'));
    try {
      await writeFile(join(workspace, 'matches.txt'), Array.from({ length: 130 }, () => 'TARGET').join(String.fromCharCode(10)));

      const result = await createGrepTool(workspace).execute(
        { pattern: 'TARGET', searchPath: workspace },
        {} as any,
      );

      expect(result.results).toHaveLength(100);
      expect(result.matches).toBe(100);
      expect(result.truncated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
