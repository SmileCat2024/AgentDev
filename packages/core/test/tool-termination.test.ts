/**
 * 工具终止协议测试（ticket 023 / ADR-0005）
 *
 * 覆盖：
 * - 超时触发合并 signal（工具收到 aborted signal + termination()='timeout'）
 * - 用户打断优先于超时
 * - settle 窗口内收尾 → success: true + interrupted 标注（timeout / user 两种 reason）
 * - 超窗未收尾 → 降级为 'Interrupted by user'
 * - 未声明 timeout 的工具零影响（无合并 controller，行为与改动前一致）
 * - fromArg clamp 边界（负数/0 → 1；超过 maxMs → maxMs；非法值回退 defaultMs）
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool, ToolExecutionContext } from '../src/core/types.js';
import type { ToolExecResult } from '../src/core/context.js';

// ========== Mock LLM ==========

/** 第一轮发起工具调用，第二轮结束。 */
class ToolCallLLM implements LLMClient {
  constructor(private readonly toolName: string, private readonly args: Record<string, unknown> = {}) {}

  async chat(messages: Message[]): Promise<LLMResponse> {
    const hasToolResults = messages.some(m => m.role === 'tool');
    if (!hasToolResults) {
      return {
        content: `Calling ${this.toolName}.`,
        toolCalls: [{ id: 'tc_1', name: this.toolName, arguments: this.args }],
      };
    }
    return { content: 'Done.' };
  }
}

/** 每轮都调用工具的 LLM（验证 timeout 后循环继续、模型可再次决策）。 */
class RepeatToolCallLLM implements LLMClient {
  constructor(
    private readonly toolName: string,
    private readonly argsFn: (callCount: number) => Record<string, unknown>,
    private readonly maxCalls = 3,
  ) {}

  private callCount = 0;

  async chat(_messages: Message[]): Promise<LLMResponse> {
    // 前 maxCalls 轮每次发起一次工具调用（模拟模型重试决策），之后收尾
    if (this.callCount < this.maxCalls) {
      this.callCount++;
      return {
        content: `Calling ${this.toolName} #${this.callCount}.`,
        toolCalls: [{ id: `tc_${this.callCount}`, name: this.toolName, arguments: this.argsFn(this.callCount) }],
      };
    }
    return { content: 'Finished.' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeAgent(llm: LLMClient, tools: Tool[]): Agent {
  return new Agent({ llm, maxTurns: 5, name: 'TerminationTestAgent', tools });
}

function lastToolResult(agent: Agent): ToolExecResult & { raw?: any } {
  const toolMessages = agent.getContext().getAll().filter(m => m.role === 'tool');
  const last = toolMessages[toolMessages.length - 1];
  return { ...(JSON.parse(last.content) as ToolExecResult), raw: last };
}

// ========== 测试用例 ==========

describe('ticket 023 工具终止协议', () => {
  describe('超时契约与 signal 合并', () => {
    it('声明 timeout 的工具：超时后收到合并 signal abort 且 termination() 返回 timeout', async () => {
      let observed: { signalAborted: boolean; termination: string | null } | undefined;

      const slowTool: Tool = {
        name: 'slow',
        description: 'Slow tool that observes termination',
        timeout: { defaultMs: 80, maxMs: 5000 },
        execute: async (_args, ctx?: ToolExecutionContext) => {
          // 等到被终止再返回（settle 窗口内 resolve）
          while (!ctx?.signal?.aborted) {
            await sleep(5);
          }
          observed = {
            signalAborted: ctx.signal.aborted,
            termination: ctx.termination?.() ?? null,
          };
          return 'partial output after timeout';
        },
      };

      const agent = makeAgent(new ToolCallLLM('slow'), [slowTool]);
      await agent.onCall('run slow tool');

      expect(observed).toBeDefined();
      expect(observed!.signalAborted).toBe(true);
      expect(observed!.termination).toBe('timeout');

      const result = lastToolResult(agent);
      expect(result.success).toBe(true);
      expect(result.interrupted).toEqual({ reason: 'timeout' });
      expect(result.result).toBe('partial output after timeout');
    });

    it('用户打断优先于超时：abort 先于计时器触发时 reason 为 user', async () => {
      let observedTermination: string | null = null;
      let started = false;

      const longTool: Tool = {
        name: 'long',
        description: 'Long tool with generous timeout',
        timeout: { defaultMs: 60_000, maxMs: 60_000 },
        execute: async (_args, ctx?: ToolExecutionContext) => {
          started = true;
          while (!ctx?.signal?.aborted) {
            await sleep(5);
          }
          observedTermination = ctx.termination?.() ?? null;
          return 'partial output before user interrupt';
        },
      };

      const agent = makeAgent(new ToolCallLLM('long'), [longTool]);
      const callPromise = agent.onCall('run long tool');

      // 等工具真正启动后再打断（用户打断早于 60s 超时）
      while (!started) {
        await sleep(2);
      }
      expect(agent.interrupt()).toBe(true);
      await callPromise;

      expect(observedTermination).toBe('user');
      const result = lastToolResult(agent);
      expect(result.success).toBe(true);
      expect(result.interrupted).toEqual({ reason: 'user' });
    });

    it('toolContext 注入 callId（与 call.id 一致，供 progress 配对）', async () => {
      let capturedCallId: string | undefined;

      const echoTool: Tool = {
        name: 'echo',
        description: 'Captures callId',
        execute: async (_args, ctx?: ToolExecutionContext) => {
          capturedCallId = ctx?.callId;
          return 'ok';
        },
      };

      const agent = makeAgent(new ToolCallLLM('echo'), [echoTool]);
      await agent.onCall('echo');

      expect(capturedCallId).toBe('tc_1');
    });
  });

  describe('settle 窗口语义', () => {
    it('窗口内 throw：走 failed 路径，不特殊处理', async () => {
      const throwingTool: Tool = {
        name: 'boom',
        description: 'Throws after being terminated',
        timeout: { defaultMs: 50, maxMs: 5000 },
        execute: async (_args, ctx?: ToolExecutionContext) => {
          while (!ctx?.signal?.aborted) {
            await sleep(5);
          }
          throw new Error('cleanup exploded');
        },
      };

      const agent = makeAgent(new ToolCallLLM('boom'), [throwingTool]);
      await agent.onCall('run boom');

      const result = lastToolResult(agent);
      expect(result.success).toBe(false);
      // 失败结果的错误信息在 result.result.error（序列化协议位置）
      expect((result.result as { error?: string }).error).toContain('cleanup exploded');
      expect(result.interrupted).toBeUndefined();
    });

    it('超窗未收尾：降级为 Interrupted by user 失败结果', async () => {
      const neverEndingTool: Tool = {
        name: 'stuck',
        description: 'Ignores the signal and never settles',
        timeout: { defaultMs: 50, maxMs: 5000 },
        execute: async () => {
          // 无视 signal，永不主动收尾（模拟卡死的进程句柄）
          await sleep(10_000);
          return 'unreachable';
        },
      };

      const agent = makeAgent(new ToolCallLLM('stuck'), [neverEndingTool]);
      const start = Date.now();
      await agent.onCall('run stuck');
      const elapsed = Date.now() - start;

      // settle 窗口 1s 内应完成降级（而非等 10s 工具超时或 60s）
      expect(elapsed).toBeLessThan(4000);

      const result = lastToolResult(agent);
      expect(result.success).toBe(false);
      expect((result.result as { error?: string }).error).toBe('Interrupted by user');
      expect(result.interrupted).toBeUndefined();
    }, 15_000);

    it('timeout 终止后 react-loop 继续循环：模型可重试并正常完成', async () => {
      let attempts = 0;
      const flakyTool: Tool = {
        name: 'flaky',
        description: 'Times out on first attempt, fast on retry',
        timeout: { defaultMs: 60, maxMs: 60_000 },
        execute: async (args: Record<string, unknown>, ctx?: ToolExecutionContext) => {
          attempts++;
          const waitMs = Number(args['waitMs'] ?? 5000);
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline && !ctx?.signal?.aborted) {
            await sleep(5);
          }
          if (ctx?.signal?.aborted) {
            return `timed out attempt ${attempts}`;
          }
          return `finished attempt ${attempts}`;
        },
      };

      // 第 1 轮长等待（60ms 默认超时触发），第 2 轮短等待（快速自然完成）
      const llm = new RepeatToolCallLLM(
        'flaky',
        (n) => ({ waitMs: n === 1 ? 5000 : 10 }),
        2,
      );
      const agent = makeAgent(llm, [flakyTool]);
      const outcome = await agent.onCallDetailed('run flaky twice');

      // timeout 后循环继续：模型第 2 轮调整参数重试并成功
      expect(attempts).toBe(2);
      expect(outcome.status).toBe('completed');

      const toolMessages = agent.getContext().getAll().filter(m => m.role === 'tool');
      expect(toolMessages.length).toBe(2);
      const first = JSON.parse(toolMessages[0].content) as ToolExecResult;
      expect(first.success).toBe(true);
      expect(first.interrupted).toEqual({ reason: 'timeout' });
      const second = JSON.parse(toolMessages[1].content) as ToolExecResult;
      expect(second.success).toBe(true);
      expect(second.interrupted).toBeUndefined();
    });

    it('user 终止后 react-loop 退出：finishReason 为 cancelled', async () => {
      let started = false;
      const longTool: Tool = {
        name: 'long',
        description: 'Long running until interrupted',
        timeout: { defaultMs: 60_000, maxMs: 60_000 },
        execute: async (_args, ctx?: ToolExecutionContext) => {
          started = true;
          while (!ctx?.signal?.aborted) {
            await sleep(5);
          }
          return 'partial before cancel';
        },
      };

      const agent = makeAgent(new ToolCallLLM('long'), [longTool]);
      const callPromise = agent.onCallDetailed('start and cancel');
      while (!started) {
        await sleep(2);
      }
      agent.interrupt();
      const outcome = await callPromise;

      // onCallDetailed 返回 CallOutcome：status/reason 表达终态
      expect(outcome.status).toBe('cancelled');
      expect(outcome.reason).toBe('cancelled');
    });
  });

  describe('未声明 timeout 的工具零影响', () => {
    it('termination 返回 null、正常完成不带 interrupted（现状路径）', async () => {
      let terminationAtEnd: string | null = 'unset';
      let sawSignal = false;

      const plainTool: Tool = {
        name: 'plain',
        description: 'No timeout declared',
        execute: async (_args, ctx?: ToolExecutionContext) => {
          // 现状路径：signal 注入逻辑与改动前一致（有外部 controller 时透传其 signal）
          sawSignal = ctx?.signal !== undefined;
          terminationAtEnd = ctx?.termination?.() ?? null;
          return 'plain done';
        },
      };

      const agent = makeAgent(new ToolCallLLM('plain'), [plainTool]);
      await agent.onCall('plain run');

      // 现状路径：executeCall 每次都创建 _abortController，signal 照旧透传（改动前行为）；
      // termination 恒返回 null（未走终止协议）
      expect(sawSignal).toBe(true);
      expect(terminationAtEnd).toBeNull();

      const result = lastToolResult(agent);
      expect(result.success).toBe(true);
      expect(result.interrupted).toBeUndefined();
      expect(result.result).toBe('plain done');
    });

    it('未声明 timeout 但外部打断：仍走降级路径（与改动前一致）', async () => {
      let started = false;
      const stubbornTool: Tool = {
        name: 'stubborn',
        description: 'No timeout declared, never settles',
        execute: async () => {
          started = true;
          await sleep(10_000);
          return 'unreachable';
        },
      };

      const agent = makeAgent(new ToolCallLLM('stubborn'), [stubbornTool]);
      const callPromise = agent.onCallDetailed('interrupt stubborn');
      while (!started) {
        await sleep(2);
      }
      agent.interrupt();
      const outcome = await callPromise;

      expect(outcome.reason).toBe('cancelled');
      const result = lastToolResult(agent);
      expect(result.success).toBe(false);
      expect((result.result as { error?: string }).error).toBe('Interrupted by user');
    }, 15_000);
  });

  describe('fromArg clamp 边界', () => {
    function clampObserverTool(): { tool: Tool; observedTimeouts: number[] } {
      const observedTimeouts: number[] = [];
      const tool: Tool = {
        name: 'clamped',
        description: 'Reports how long until terminated',
        timeout: { defaultMs: 300, maxMs: 1000, fromArg: 'waitTimeoutMs' },
        execute: async (args: Record<string, unknown>, ctx?: ToolExecutionContext) => {
          const start = Date.now();
          while (!ctx?.signal?.aborted) {
            await sleep(5);
            if (Date.now() - start > 2500) break; // 兜底防挂死
          }
          observedTimeouts.push(Date.now() - start);
          return 'done';
        },
      };
      return { tool, observedTimeouts };
    }

    it('负数参数 clamp 到 1ms 下限', async () => {
      const { tool, observedTimeouts } = clampObserverTool();
      const agent = makeAgent(new ToolCallLLM('clamped', { waitTimeoutMs: -50 }), [tool]);
      await agent.onCall('negative timeout arg');

      expect(observedTimeouts.length).toBe(1);
      expect(observedTimeouts[0]).toBeLessThan(200); // 远小于 defaultMs=300

      const result = lastToolResult(agent);
      expect(result.interrupted).toEqual({ reason: 'timeout' });
    });

    it('超过 maxMs 的参数 clamp 到上限', async () => {
      const { tool, observedTimeouts } = clampObserverTool();
      const agent = makeAgent(new ToolCallLLM('clamped', { waitTimeoutMs: 999_999 }), [tool]);
      const start = Date.now();
      await agent.onCall('huge timeout arg');
      const elapsed = Date.now() - start;

      // 上限 1000ms + settle 窗口，远小于 999s
      expect(elapsed).toBeLessThan(4000);
      expect(observedTimeouts[0]).toBeLessThan(1300); // ≈maxMs

      const result = lastToolResult(agent);
      expect(result.interrupted).toEqual({ reason: 'timeout' });
    }, 15_000);

    it('非法参数（字符串）回退到 defaultMs', async () => {
      const { tool, observedTimeouts } = clampObserverTool();
      const agent = makeAgent(new ToolCallLLM('clamped', { waitTimeoutMs: 'not-a-number' }), [tool]);
      const start = Date.now();
      await agent.onCall('invalid timeout arg');
      const elapsed = Date.now() - start;

      // defaultMs=300 生效
      expect(elapsed).toBeLessThan(4000);
      expect(observedTimeouts[0]).toBeGreaterThanOrEqual(280);
      expect(observedTimeouts[0]).toBeLessThan(600);

      const result = lastToolResult(agent);
      expect(result.interrupted).toEqual({ reason: 'timeout' });
    }, 15_000);
  });

  describe('结果 schema 透传', () => {
    it('session-events tool_call 条目透传 interrupted 字段', async () => {
      const { subscribeSessionEvents } = await import('../src/core/session-events.js');
      const events: any[] = [];
      const unsubscribe = subscribeSessionEvents(e => events.push(e));

      try {
        const slowTool: Tool = {
          name: 'slow2',
          description: 'Slow tool for session-events test',
          timeout: { defaultMs: 50, maxMs: 5000 },
          execute: async (_args, ctx?: ToolExecutionContext) => {
            while (!ctx?.signal?.aborted) {
              await sleep(5);
            }
            return 'partial for audit';
          },
        };

        const agent = makeAgent(new ToolCallLLM('slow2'), [slowTool]);
        await agent.onCall('audit me');

        const completed = events.filter(e => e.type === 'item.completed' && e.item.type === 'tool_call');
        expect(completed.length).toBeGreaterThanOrEqual(1);
        expect(completed[completed.length - 1].item.status).toBe('completed');
        expect(completed[completed.length - 1].item.interrupted).toEqual({ reason: 'timeout' });
      } finally {
        unsubscribe();
      }
    });

    it('addToolMessage 序列化透传 interrupted 字段', async () => {
      const slowTool: Tool = {
        name: 'slow3',
        description: 'Slow tool for serialization test',
        timeout: { defaultMs: 50, maxMs: 5000 },
        execute: async (_args, ctx?: ToolExecutionContext) => {
          while (!ctx?.signal?.aborted) {
            await sleep(5);
          }
          return 'serialized partial';
        },
      };

      const agent = makeAgent(new ToolCallLLM('slow3'), [slowTool]);
      await agent.onCall('serialize me');

      const toolMessages = agent.getContext().getAll().filter(m => m.role === 'tool');
      const parsed = JSON.parse(toolMessages[toolMessages.length - 1].content);
      expect(parsed.success).toBe(true);
      expect(parsed.result).toBe('serialized partial');
      expect(parsed.interrupted).toEqual({ reason: 'timeout' });
    });
  });

  describe('createToolProgress schema', () => {
    it('构造 tool.progress state 通知，字段齐全', async () => {
      const { createToolProgress } = await import('../src/core/notification.js');
      const n = createToolProgress({
        callId: 'tc_9',
        toolName: 'shell',
        startedAt: Date.now() - 120,
        elapsedMs: 120,
        timeoutMs: 60_000,
        outputTail: 'last line of output',
      });

      expect(n.type).toBe('tool.progress');
      expect(n.category).toBe('state');
      expect(n.data).toMatchObject({
        callId: 'tc_9',
        toolName: 'shell',
        elapsedMs: 120,
        timeoutMs: 60_000,
        outputTail: 'last line of output',
      });
      expect(typeof (n.data as any).startedAt).toBe('number');
    });
  });
});
