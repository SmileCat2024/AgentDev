/**
 * grep 工具 ripgrep 三级回退 — 全缺失降级路径
 *
 * 覆盖：@vscode/ripgrep 包缺失（optionalDependencies 安装失败被 npm 跳过）
 * 且 PATH 中无 rg 时，grep 报出明确的可操作错误，
 * 而非模块解析异常（ERR_MODULE_NOT_FOUND 不得泄漏到工具调用层）。
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrepTool } from '../../src/features/opencode-basic/tools.js';

// 模拟 @vscode/ripgrep 未随包安装：模块解析直接失败
vi.mock('@vscode/ripgrep', () => {
  throw new Error("Cannot find package '@vscode/ripgrep'");
});

// PATH 指向空目录，保证 spawn('rg') 解析失败
const emptyDir = mkdtempSync(join(tmpdir(), 'rg-empty-path-'));
const originalPath = process.env.PATH;

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(emptyDir, { recursive: true, force: true });
});

describe('grep ripgrep unavailable', () => {
  it('rejects with actionable message when neither PATH nor bundled rg exists', async () => {
    process.env.PATH = emptyDir;

    const workDir = mkdtempSync(join(tmpdir(), 'rg-search-'));
    try {
      const grepTool = createGrepTool(workDir);

      await expect(grepTool.execute({ pattern: 'needle' })).rejects.toThrow(
        /ripgrep \(rg\) is not available/
      );
      // 不得把模块解析异常直接抛给工具调用层
      await expect(grepTool.execute({ pattern: 'needle' })).rejects.not.toThrow(
        /Cannot find package/
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 10000);
});
