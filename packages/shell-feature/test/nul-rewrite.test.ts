/**
 * bash / bash_bg 的 CMD null-redirect 重写记录测试（ADR-0023 确定性纠正类）
 *
 * `>nul` → `>/dev/null`：Git Bash 会把 nul 当字面量文件创建（Windows 保留名），
 * 重写保护命令不产生垃圾文件；ADR-0023 要求历史记录生效命令。
 *
 * 覆盖：
 * - bash：含 >nul 命令 + callId → withRewrite 生效命令，且工作区不产生 nul 文件
 * - bash：无 >nul 命令 → 普通文本返回，不触发改写
 * - bash_bg：捕获窗内完成的含 >nul 命令 → 同样记录生效命令
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BgRegistry } from '../src/bg-core.js';
import { createBashBgTool, createShellCommandTool } from '../src/index.js';
import { findGitBashPath } from '../src/tools.js';
import { isWithRewriteResult } from '@agentdevjs/core';

const workdir = mkdtempSync(join(tmpdir(), 'agentdev-nul-rewrite-'));

function makeRegistry(): BgRegistry {
  return new BgRegistry({
    agentId: 'agent-nul-rewrite-test',
    enableExitGuard: false,
    deliverImpl: async () => {},
  });
}

describe('bash >nul rewrite recording (ADR-0023)', () => {
  it('bash: 含 >nul 命令 → 生效命令记录为 >/dev/null，且不创建 nul 文件', async () => {
    const tool = createShellCommandTool('test bash', {
      workdir,
      bashPath: findGitBashPath()!,
      resourceRoot: process.cwd(),
    });
    const result = await tool.execute!(
      { command: 'echo hi >nul && echo done' } as never,
      { callId: 'tc_nul_1' } as never,
    );

    expect(isWithRewriteResult(result)).toBe(true);
    const rw = result as {
      text: string;
      effectiveCall: { id: string; name: string; arguments: { command: string } };
    };
    expect(rw.effectiveCall.id).toBe('tc_nul_1');
    expect(rw.effectiveCall.name).toBe('bash');
    expect(rw.effectiveCall.arguments.command).toContain('/dev/null');
    expect(rw.effectiveCall.arguments.command).not.toMatch(/>+\s*nul\b/i);
    // 命令真实执行：重定向静默后后续输出照常
    expect(rw.text).toContain('done');
    // 重写的本意：不产生 Windows 保留名文件
    expect(existsSync(join(workdir, 'nul'))).toBe(false);
  }, 10_000);

  it('bash: 无 >nul 命令 → 普通文本返回，不触发改写', async () => {
    const tool = createShellCommandTool('test bash', {
      workdir,
      bashPath: findGitBashPath()!,
      resourceRoot: process.cwd(),
    });
    const result = await tool.execute!(
      { command: 'echo plain' } as never,
      { callId: 'tc_nul_2' } as never,
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('plain');
    expect(isWithRewriteResult(result)).toBe(false);
  }, 10_000);

  it('bash_bg: 捕获窗内完成的含 >nul 命令 → 同样记录生效命令', async () => {
    const registry = makeRegistry();
    const tool = createBashBgTool('test bg', {
      workdir,
      bashPath: findGitBashPath()!,
      resourceRoot: process.cwd(),
      registry,
    });
    const result = await tool.execute!(
      { command: 'echo bg-out >nul && echo bg-done' } as never,
      { callId: 'tc_nul_3' } as never,
    );

    expect(isWithRewriteResult(result)).toBe(true);
    const rw = result as {
      text: string;
      effectiveCall: { arguments: { command: string } };
    };
    expect(rw.effectiveCall.arguments.command).toContain('/dev/null');
    expect(rw.text).toContain('bg-done');
    expect(existsSync(join(workdir, 'nul'))).toBe(false);
    expect(registry.list().length).toBe(0);
  }, 10_000);
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});
