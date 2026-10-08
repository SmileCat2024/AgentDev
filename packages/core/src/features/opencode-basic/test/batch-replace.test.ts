import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createBatchReplaceTool } from '../tools.js';

/**
 * 每个用例独立建目录：用例之间无顺序耦合，
 * 断言只反映当前用例的操作效果。
 */
async function setupTree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'batch-replace-'));
  await mkdir(path.join(dir, 'src', 'sub'), { recursive: true });
  await mkdir(path.join(dir, 'skip-me'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });

  await writeFile(path.join(dir, 'src', 'a.ts'), "import { x } from 'agentdev';\nconst a = 1;\n");
  await writeFile(path.join(dir, 'src', 'b.ts'), "import { y } from 'agentdev';\nconst b = 2;\n");
  await writeFile(path.join(dir, 'src', 'sub', 'c.ts'), "import { z } from 'agentdev';\n");
  await writeFile(path.join(dir, 'src', 'keep.ts'), 'no match here\n');
  await writeFile(path.join(dir, 'skip-me', 'd.ts'), "import { w } from 'agentdev';\n");
    await writeFile(path.join(dir, 'node_modules', 'x', 'e.ts'), 'NODE_MODULES_MARKER\n');
  await writeFile(path.join(dir, 'src', 'crlf.ts'), 'line1\r\nOLD\r\nline3\r\n');
  await writeFile(path.join(dir, 'src', 'bin.dat'), Buffer.from('OLD\x00OLD'));
  return dir;
}

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop()!, { recursive: true, force: true });
  }
});

type BatchResult = { text: string; display: { diff: string; filesMatched: number; totalReplacements: number } };

async function run(dir: string, args: Record<string, unknown>): Promise<BatchResult> {
  const tool = createBatchReplaceTool(dir);
  return (await tool.execute(args)) as BatchResult;
}

describe('batch_replace tool', () => {
  it('replaces a literal string across matched files with per-file counts', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['src/**/*.ts'],
      find: "from 'agentdev'",
      replace: "from '@agentdev/core'",
    });
    const parsed = JSON.parse(res.text);

    expect(parsed.filesMatched).toBe(3);
    expect(parsed.totalReplacements).toBe(3);
    expect(parsed.perFile).toHaveLength(3);
    expect(res.display.totalReplacements).toBe(3);
    expect(res.display.diff).toContain('@agentdev/core');

    const a = await readFile(path.join(dir, 'src', 'a.ts'), 'utf8');
    expect(a).toContain("from '@agentdev/core'");
    const keep = await readFile(path.join(dir, 'src', 'keep.ts'), 'utf8');
    expect(keep).toBe('no match here\n');
  });

  it('excludes patterns passed via exclude', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['**/*.ts'],
      find: 'const a = 1',
      replace: 'const a = 42',
      exclude: ['skip-me/**'],
    });
    const parsed = JSON.parse(res.text);
    expect(parsed.totalReplacements).toBe(1);
    const d = await readFile(path.join(dir, 'skip-me', 'd.ts'), 'utf8');
    expect(d).toContain("'agentdev'");
  });

  it('always ignores node_modules regardless of patterns', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['**/*.ts'],
      find: 'NODE_MODULES_MARKER',
      replace: 'x',
    });
    const parsed = JSON.parse(res.text);
    // 标记只存在于 node_modules/x/e.ts，零替换证明该目录始终被排除
    expect(parsed.totalReplacements).toBe(0);
  });

  it('supports regex mode with group references', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['src/*.ts'],
      find: 'const (a|b) = \\d+',
      replace: 'const $1 = 99',
      regex: true,
    });
    const parsed = JSON.parse(res.text);
    expect(parsed.totalReplacements).toBe(2);
    const a = await readFile(path.join(dir, 'src', 'a.ts'), 'utf8');
    expect(a).toContain('const a = 99');
  });

  it('adapts multi-line LF find to CRLF files and preserves CRLF on write', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['src/crlf.ts'],
      find: 'line1\nOLD',
      replace: 'first\nNEW',
    });
    const parsed = JSON.parse(res.text);
    expect(parsed.totalReplacements).toBe(1);

    const content = await readFile(path.join(dir, 'src', 'crlf.ts'), 'utf8');
    expect(content).toBe('first\r\nNEW\r\nline3\r\n');
  });

  it('normalizes literal escape sequences arriving as backslash text (LF file)', async () => {
    const dir = setupTreeSync(await setupTree());
    await writeFile(path.join(dir, 'src', 'lf.txt'), 'alpha\nbeta\n');
    // find/replace 以字面反斜杠序列到达（参数传输字面化）
    const res = await run(dir, {
      paths: ['src/lf.txt'],
      find: 'alpha\\nbeta',
      replace: 'one\\ntwo',
    });
    const parsed = JSON.parse(res.text);
    expect(parsed.totalReplacements).toBe(1);
    expect(parsed.escapeNormalized).toBe(true);
    expect(await readFile(path.join(dir, 'src', 'lf.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('chains escape normalization with CRLF adaptation for literal \\r\\n / \\n forms on CRLF files', async () => {
    const dir = setupTreeSync(await setupTree());
    // 字面 \r\n 形态：反转义后即 CRLF，原样命中
    const res1 = await run(dir, {
      paths: ['src/crlf.ts'],
      find: 'line1\\r\\nOLD',
      replace: 'first\\r\\nNEW',
    });
    expect(JSON.parse(res1.text).totalReplacements).toBe(1);
    expect(await readFile(path.join(dir, 'src', 'crlf.ts'), 'utf8')).toBe('first\r\nNEW\r\nline3\r\n');

    // 字面 \n 形态：反转义出 LF → CRLF 文件零命中 → 行尾适配
    const dir2 = setupTreeSync(await setupTree());
    const res2 = await run(dir2, {
      paths: ['src/crlf.ts'],
      find: 'line1\\nOLD',
      replace: 'first\\nNEW',
    });
    expect(JSON.parse(res2.text).totalReplacements).toBe(1);
    expect(await readFile(path.join(dir2, 'src', 'crlf.ts'), 'utf8')).toBe('first\r\nNEW\r\nline3\r\n');
  });

  it('does not unescape regex-mode find (backslashes are regex syntax)', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['src/a.ts'],
      find: 'const a = \\d',
      replace: 'const a = 7',
      regex: true,
    });
    expect(JSON.parse(res.text).totalReplacements).toBe(1);
    expect(await readFile(path.join(dir, 'src', 'a.ts'), 'utf8')).toContain('const a = 7');
  });

  it('skips binary files containing NUL bytes and reports them', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['src/bin.dat'],
      find: 'OLD',
      replace: 'NEW',
    });
    const parsed = JSON.parse(res.text);
    expect(parsed.totalReplacements).toBe(0);
    expect(parsed.skippedBinary).toEqual([path.join(dir, 'src', 'bin.dat')]);
  });

  it('reports no occurrences without modifying files', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['src/keep.ts'],
      find: 'NOT-PRESENT',
      replace: 'x',
    });
    const parsed = JSON.parse(res.text);
    expect(parsed.totalReplacements).toBe(0);
    expect(parsed.message).toContain('No occurrences');
    expect(await readFile(path.join(dir, 'src', 'keep.ts'), 'utf8')).toBe('no match here\n');
  });

  it('returns empty result for patterns matching no files', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['**/*.nomatch'],
      find: 'a',
      replace: 'b',
    });
    const parsed = JSON.parse(res.text);
    expect(parsed.message).toContain('No files matched');
    expect(parsed.totalReplacements).toBe(0);
  });

  it('rejects invalid regular expressions', async () => {
    const dir = setupTreeSync(await setupTree());
    await expect(
      run(dir, { paths: ['src/**/*.ts'], find: '(', replace: 'x', regex: true })
    ).rejects.toThrow(/Invalid regular expression/);
  });

  it('refuses to run when glob matches more than the file limit', async () => {
    const bigDir = setupTreeSync(await mkdtemp(path.join(tmpdir(), 'batch-replace-limit-')));
    for (let i = 0; i < 501; i++) {
      await writeFile(path.join(bigDir, `f${i}.ts`), 'seed\n');
    }
    await expect(
      run(bigDir, { paths: ['*.ts'], find: 'seed', replace: 'done' })
    ).rejects.toThrow(/exceeding the limit/);
  });

  it('handles a single-file pattern as the degenerate case', async () => {
    const dir = setupTreeSync(await setupTree());
    const res = await run(dir, {
      paths: ['src/b.ts'],
      find: "from 'agentdev'",
      replace: "from '@agentdev/core'",
    });
    const parsed = JSON.parse(res.text);
    expect(parsed.perFile).toEqual([
      { file: path.join(dir, 'src', 'b.ts'), count: 1 },
    ]);
  });
});

/** 登记 dir 供 afterEach 统一清理 */
function setupTreeSync(dir: string): string {
  dirs.push(dir);
  return dir;
}
