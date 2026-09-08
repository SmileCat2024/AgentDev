/**
 * grep 工具 ripgrep 三级回退 — bundled 二进制路径
 *
 * 覆盖：PATH 中无 rg 时，回退到 @vscode/ripgrep 随包分发的二进制，
 * grep 仍可正常完成真实搜索（真实子进程 + 真实 IO，放宽时长预算）。
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrepTool } from '../../src/features/opencode-basic/tools.js';

// PATH 指向空目录，保证 spawn('rg') 解析失败（probePathRipgrep 返回 null）
const emptyDir = mkdtempSync(join(tmpdir(), 'rg-empty-path-'));
const originalPath = process.env.PATH;

let workDir: string;

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(emptyDir, { recursive: true, force: true });
});

describe('grep bundled ripgrep fallback', () => {
  it('falls back to @vscode/ripgrep binary when rg is not on PATH', async () => {
    process.env.PATH = emptyDir;

    workDir = mkdtempSync(join(tmpdir(), 'rg-search-'));
    writeFileSync(join(workDir, 'sample.txt'), 'hello needle\nother line\n');

    const grepTool = createGrepTool(workDir);
    const result = await grepTool.execute({ pattern: 'needle' });

    expect(result.matches).toBe(1);
    expect(result.results[0].lineText).toBe('hello needle');
    expect(result.results[0].path).toContain('sample.txt');
  }, 10000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });
});
