/**
 * shell 工具终止收集与 <shell_metadata> 测试（ticket 024 / ADR-0005）
 *
 * 覆盖：
 * - bash/powershell 共享三态语义：
 *   1) 超时终止 → kill + drain 后 resolve，结果含部分输出与元数据块（reason: timeout）
 *   2) 用户打断（signal aborted）→ 同上（reason: user），本轮由 react-loop 收尾
 *   3) 正常完成 → 干净输出，无元数据块
 * - args.timeout 由 executor clamp；工具不再内部计时（timeout 契约声明消费 ticket 023）
 * - 元数据字段：terminated / reason / durationMs / exitCode(null when killed) /
 *   outputBytes / truncated / logPath（终止态无条件落盘）
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@agentdev/core';
import type { LLMClient, LLMResponse, Message, ToolExecutionContext, ToolTerminationReason } from '@agentdev/core';
import {
  createShellCommandTool,
  createPowerShellTool,
  findGitBashPath,
} from '../src/index.js';

const workdir = mkdtempSync(join(tmpdir(), 'agentdev-shell-024-'));
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** 构造模拟 executor 注入的 toolContext（ticket 023 合并 signal 契约）。 */
function makeContext(opts: {
  terminateAfterMs?: number;
  reason?: ToolTerminationReason;
} = {}): ToolExecutionContext & { controller: AbortController } {
  const controller = new AbortController();
  let reason: ToolTerminationReason | null = null;
  let deadline: number | null = null;
  if (opts.terminateAfterMs !== undefined) {
    setTimeout(() => {
      reason = opts.reason ?? 'timeout';
      deadline = Date.now() + 1000;
      controller.abort();
    }, opts.terminateAfterMs).unref();
  }
  return {
    controller,
    signal: controller.signal,
    termination: () => reason,
    terminationDeadline: () => deadline,
    callId: 'tc_test_1',
  };
}

/** 解析结果尾部的 <shell_metadata> 块。 */
function parseMetadata(output: string): Record<string, unknown> {
  const m = output.match(/<shell_metadata>\s*\n([\s\S]*?)\n\s*<\/shell_metadata>/);
  expect(m, 'output should contain a <shell_metadata> block').toBeTruthy();
  const fields: Record<string, unknown> = {};
  for (const line of m![1]!.split('\n')) {
    const kv = line.match(/^([\w]+):\s*(.*)$/);
    if (kv) fields[kv[1]!] = kv[2];
  }
  return fields;
}

const bashPath = findGitBashPath();
const BASH_SKIP = !bashPath ? 'bash not available' : false;

class ShellIntegrationLLM implements LLMClient {
  public readonly observedToolResults: string[] = [];

  async chat(messages: Message[]): Promise<LLMResponse> {
    const toolMessage = messages.find(message => message.role === 'tool');
    if (!toolMessage) {
      return {
        content: 'Run the shell command.',
        toolCalls: [{
          id: 'shell-integration-call',
          name: 'bash',
          arguments: { command: 'for i in 1 2 3 4 5; do echo "integration-tick-$i"; sleep 0.3; done' },
        }],
      };
    }
    this.observedToolResults.push(toolMessage.content);
    return { content: 'I received the shell result.' };
  }
}

// ===========================================================================
// bash 三态
// ===========================================================================

describe.skipIf(BASH_SKIP)('bash 终止收集与元数据（ticket 024）', () => {
  it('经 Agent executor：模型收到部分输出、shell_metadata 与 timeout reason', async () => {
    const llm = new ShellIntegrationLLM();
    const bash = createShellCommandTool('test bash', {
      workdir,
      bashPath,
      timeoutMs: 300,
      maxTimeoutMs: 300,
    });
    const agent = new Agent({ llm, maxTurns: 3, name: 'ShellIntegrationAgent', tools: [bash] });

    const outcome = await agent.onCallDetailed('run integration shell command');

    expect(outcome.status).toBe('completed');
    expect(llm.observedToolResults).toHaveLength(1);
    expect(llm.observedToolResults[0]).toContain('integration-tick-1');
    expect(llm.observedToolResults[0]).toContain('<shell_metadata>');
    expect(llm.observedToolResults[0]).toContain('reason: timeout');
    expect(llm.observedToolResults[0]).not.toContain('Interrupted by user');
  }, 15_000);

  it('经 Agent executor：手动 interrupt 也保留部分输出并标记 user', async () => {
    let toolStarted = false;
    const llm: LLMClient = {
      async chat(messages: Message[]): Promise<LLMResponse> {
        if (!messages.some(message => message.role === 'tool')) {
          toolStarted = true;
          return {
            content: 'Run the shell command.',
            toolCalls: [{
              id: 'shell-user-interrupt-call',
              name: 'bash',
              arguments: { command: 'echo user-before; sleep 30' },
            }],
          };
        }
        return { content: 'I received the interrupted shell result.' };
      },
    };
    const bash = createShellCommandTool('test bash', {
      workdir,
      bashPath,
      timeoutMs: 60_000,
      maxTimeoutMs: 60_000,
    });
    const agent = new Agent({ llm, maxTurns: 3, name: 'ShellUserInterruptAgent', tools: [bash] });
    const callPromise = agent.onCallDetailed('run and interrupt shell command');

    while (!toolStarted) await new Promise(resolve => setTimeout(resolve, 2));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(agent.interrupt()).toBe(true);

    const outcome = await callPromise;
    const toolMessage = agent.getContext().getAll().find(message => message.role === 'tool');
    expect(outcome.status).toBe('cancelled');
    expect(toolMessage?.content).toContain('user-before');
    expect(toolMessage?.content).toContain('<shell_metadata>');
    expect(toolMessage?.content).toContain('reason: user');
    expect(toolMessage?.content).not.toBe('{"success":false,"result":{"error":"Interrupted by user"}}');
  }, 15_000);

  it('超时：返回已积累的部分输出 + 元数据块（terminated/reason=timeout/exitCode=null/logPath）', async () => {
    const tool = createShellCommandTool('test bash', { workdir });
    // 慢速滴流输出，永不自行退出；框架侧 300ms 触发合并 signal
    const ctx = makeContext({ terminateAfterMs: 300 });
    const result = await tool.execute(
      { command: `for i in 1 2 3 4 5; do echo "tick $i"; sleep 0.3; done` },
      ctx,
    ) as string;

    expect(result).toContain('tick');
    expect(result).toContain('<shell_metadata>');
    const meta = parseMetadata(result);
    expect(meta['terminated']).toBe('true');
    expect(meta['reason']).toBe('timeout');
    expect(meta['exitCode']).toBe('null');
    expect(Number(meta['durationMs'])).toBeGreaterThanOrEqual(250);
    expect(Number(meta['outputBytes'])).toBeGreaterThan(0);
    // 终止态必须落盘完整已积累输出
    expect(meta['truncated']).toBe('false');
    const logPath = String(meta['logPath']);
    expect(logPath).toContain('bash-output-');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf-8')).toContain('tick 1');
  }, 15_000);

  it('用户打断：kill 后 resolve，reason=user', async () => {
    const tool = createShellCommandTool('test bash', { workdir });
    const ctx = makeContext({ terminateAfterMs: 250, reason: 'user' });
    const result = await tool.execute(
      { command: `echo before-stop; sleep 30` },
      ctx,
    ) as string;

    expect(result).toContain('before-stop');
    const meta = parseMetadata(result);
    expect(meta['terminated']).toBe('true');
    expect(meta['reason']).toBe('user');
    expect(meta['exitCode']).toBe('null');
    expect(existsSync(String(meta['logPath']))).toBe(true);
  }, 15_000);

  it('正常完成：干净输出，无元数据块', async () => {
    const tool = createShellCommandTool('test bash', { workdir });
    const ctx = makeContext();
    const result = await tool.execute({ command: `echo hello-normal` }, ctx) as string;

    expect(result).toContain('hello-normal');
    expect(result).not.toContain('<shell_metadata>');
  }, 15_000);

  it('args.timeout 不再被工具内部消费（计时职责归 executor，契约声明 fromArg）', () => {
    const tool = createShellCommandTool('test bash', { workdir });
    expect(tool.name).toBe('bash');
    expect(tool.timeout).toEqual({
      defaultMs: 120_000,
      maxMs: 600_000,
      fromArg: 'timeout',
    });
  });

  it('执行前 signal 已 aborted：立即返回空输出的终止结果', async () => {
    const tool = createShellCommandTool('test bash', { workdir });
    const ctx = makeContext();
    ctx.controller.abort();
    (ctx as { termination?: () => ToolTerminationReason | null }).termination = () => 'user';
    const result = await tool.execute({ command: `echo should-not-run` }, ctx) as string;

    expect(result).not.toContain('should-not-run');
    expect(result).toContain('<shell_metadata>');
    const meta = parseMetadata(result);
    expect(meta['terminated']).toBe('true');
    expect(meta['reason']).toBe('user');
  }, 15_000);
});

// ===========================================================================
// powershell 与 bash 逐项对齐
// ===========================================================================

describe('powershell 三态同 bash（ticket 024 验收）', () => {
  it('工具契约声明一致（name / timeout fromArg / render）', () => {
    const ps = createPowerShellTool('test ps', { workdir });
    expect(ps.name).toBe('powershell');
    expect(ps.render).toBeDefined();
    const bash = createShellCommandTool('test bash', { workdir });
    expect(ps.timeout).toEqual(bash.timeout);
  });

  it.skipIf(BASH_SKIP)('超时：部分输出 + 元数据块（reason=timeout），与 bash 同构', async () => {
    const tool = createPowerShellTool('test ps', { workdir });
    const ctx = makeContext({ terminateAfterMs: 300 });
    const result = await tool.execute(
      { command: `1..10 | ForEach-Object { "ps tick $_"; Start-Sleep -Milliseconds 250 }` },
      ctx,
    ) as string;

    expect(result).toContain('ps tick');
    const meta = parseMetadata(result);
    expect(meta['terminated']).toBe('true');
    expect(meta['reason']).toBe('timeout');
    expect(meta['exitCode']).toBe('null');
    expect(existsSync(String(meta['logPath']))).toBe(true);
  }, 15_000);

  it.skipIf(BASH_SKIP)('用户打断：kill 后 resolve（reason=user），与 bash 同构', async () => {
    const tool = createPowerShellTool('test ps', { workdir });
    const ctx = makeContext({ terminateAfterMs: 200, reason: 'user' });
    const result = await tool.execute(
      { command: `"before-stop"; Start-Sleep -Seconds 30` },
      ctx,
    ) as string;

    expect(result).toContain('before-stop');
    const meta = parseMetadata(result);
    expect(meta['terminated']).toBe('true');
    expect(meta['reason']).toBe('user');
  }, 15_000);

  it.skipIf(BASH_SKIP)('正常完成：无元数据块，与 bash 同构', async () => {
    const tool = createPowerShellTool('test ps', { workdir });
    const ctx = makeContext();
    const result = await tool.execute({ command: `Write-Output ps-normal` }, ctx) as string;

    expect(result).toContain('ps-normal');
    expect(result).not.toContain('<shell_metadata>');
  }, 15_000);
});

// ===========================================================================
// args.timeout 由 executor clamp（工具声明 fromArg 契约，计时归 executor）
// ===========================================================================

describe('args.timeout clamp（ticket 023 executor 职责，工具侧仅声明契约）', () => {
  it('timeout 参数不再被工具消费：execute 不读取 args.timeout', async () => {
    // 工具 execute 的 args 解构只取 command；timeout 完全由 executor clamp 后
    // 经合并 signal 表达。此处验证传非法 timeout 不影响正常执行。
    const tool = createShellCommandTool('test bash', { workdir });
    const ctx = makeContext();
    const result = await tool.execute(
      { command: `echo clamp-ok`, timeout: 'not-a-number' },
      ctx,
    ) as string;
    expect(result).toContain('clamp-ok');
  }, 15_000);
});

// ===========================================================================
// manifest 配置项
// ===========================================================================

describe('manifest 配置（ticket 024 步骤 5）', () => {
  it('getFeatureManifest 声明 defaultTimeoutMs / maxTimeoutMs 且默认值正确', async () => {
    const { ShellFeature } = await import('../src/index.js');
    const feature = new ShellFeature({ workdir });
    const manifest = feature.getFeatureManifest();
    expect(manifest).toBeTruthy();
    const props = manifest!.settings!.properties;
    expect(props['defaultTimeoutMs']).toMatchObject({
      type: 'number',
      default: 120_000,
      min: 1,
      max: 600_000,
    });
    expect(props['maxTimeoutMs']).toMatchObject({
      type: 'number',
      default: 600_000,
      min: 1,
    });
  });
});
