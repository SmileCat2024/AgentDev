/**
 * 轮次挂起语义测试（ADR-0019 阶段 1）
 *
 * 覆盖：
 * - 判定矩阵：pendingWakeups 空/非空 × 自然完成 / reverse-hook deny / error / cancelled / continuation
 * - 优先序：error、cancelled、limit_reached、continued 等终态不被 suspended 覆盖
 * - status 映射：suspended → continued（不新增 status 值）；outcome.pendingWakeups 透传
 * - 事件：suspended 走 turn.completed（带 suspended 标志），不发 turn.failed（挂起不是失败）
 * - pending-work 申报通道：多 provider 聚合、异常 provider 按空处理、未注册降级
 * - StepFinishDecisionContext.hasPendingWakeups 填充
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import { subscribeSessionEvents } from '../src/core/session-events.js';
import type { SessionEvent } from '../src/core/session-events.js';
import { CoreLifecycle, Decision } from '../src/core/lifecycle.js';
import type {
  CallStartContext,
  HookDeclarations,
  PendingWakeup,
  StepFinishDecisionContext,
} from '../src/core/lifecycle.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool, ToolExecutionContext } from '../src/core/types.js';

// ========== Mock LLM ==========

class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

class ThrowingLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    throw new Error('model exploded');
  }
}

/** 第一轮发起工具调用，收到工具结果后收尾。 */
class ToolCallLLM implements LLMClient {
  constructor(private readonly toolName: string) {}

  async chat(messages: Message[]): Promise<LLMResponse> {
    const hasToolResults = messages.some(m => m.role === 'tool');
    if (!hasToolResults) {
      return {
        content: `Calling ${this.toolName}.`,
        toolCalls: [{ id: 'tc_1', name: this.toolName, arguments: {} }],
      };
    }
    return { content: 'Done.' };
  }
}

/** 每轮都发起工具调用（驱动 limit_reached）。 */
class AlwaysToolCallLLM implements LLMClient {
  constructor(private readonly toolName: string) {}

  async chat(_messages: Message[]): Promise<LLMResponse> {
    return {
      content: 'Working.',
      toolCalls: [{ id: `tc_${Date.now()}`, name: this.toolName, arguments: {} }],
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const WAKEUPS: PendingWakeup[] = [
  { source: 'shell', id: 'bg-1', summary: 'npm run build' },
];

function registerShellProvider(agent: Agent, items: PendingWakeup[] = WAKEUPS): void {
  agent.registerPendingWorkProvider('shell', () => items);
}

// ========== 测试用 Feature ==========

/** StepFinish guard（advisor）：Deny 结束当前回合（bg_wait 的既有语义路径）。 */
class DenyStepFinishFeature implements AgentFeature {
  readonly name = 'deny-step-finish';
  readonly dependencies: string[] = [];
  static hooks: HookDeclarations = {
    deny: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
  };

  async deny(_ctx: StepFinishDecisionContext): Promise<typeof Decision.Deny> {
    return Decision.Deny;
  }
}

/** StepFinish guard（advisor）：捕获决策上下文事实位。 */
class StepFinishProbeFeature implements AgentFeature {
  readonly name = 'step-finish-probe';
  readonly dependencies: string[] = [];
  static hooks: HookDeclarations = {
    probe: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
  };

  captured: StepFinishDecisionContext[] = [];

  async probe(ctx: StepFinishDecisionContext): Promise<typeof Decision.Continue> {
    this.captured.push(ctx);
    return Decision.Continue;
  }
}

// ========== 判定矩阵与 status 映射 ==========

describe('suspended 判定与 status 映射', () => {
  it('自然完成 + pending 非空 → suspended：status continued、pendingWakeups 透传', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    registerShellProvider(agent);

    const outcome = await agent.onCallDetailed('build it');

    expect(outcome.reason).toBe('suspended');
    // 不新增 status 值：挂起 = 移交给后续唤醒单元
    expect(outcome.status).toBe('continued');
    expect(outcome.pendingWakeups).toEqual(WAKEUPS);
  });

  it('自然完成 + 未注册 provider → 降级现状 completed（无 pendingWakeups 字段）', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });

    const outcome = await agent.onCallDetailed('hello');

    expect(outcome.reason).toBe('completed');
    expect(outcome.status).toBe('completed');
    expect(outcome.pendingWakeups).toBeUndefined();
  });

  it('provider 返回空数组 → completed（pending 空不触发改判）', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    registerShellProvider(agent, []);

    const outcome = await agent.onCallDetailed('hello');

    expect(outcome.reason).toBe('completed');
    expect(outcome.status).toBe('completed');
    expect(outcome.pendingWakeups).toBeUndefined();
  });

  it('StepFinish guard Deny 结束的回合（bg_wait 语义路径）+ pending → suspended', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 3 });
    agent.use(new DenyStepFinishFeature() as any);
    registerShellProvider(agent);

    const outcome = await agent.onCallDetailed('wait for build');

    // deny 路径 react-loop 返回 finishReason 'completed'，盖戳点统一改判
    expect(outcome.reason).toBe('suspended');
    expect(outcome.status).toBe('continued');
    expect(outcome.pendingWakeups).toEqual(WAKEUPS);
  });
});

// ========== 优先序：更强终态不被覆盖 ==========

describe('终态优先序（error > cancelled > suspended > continued > completed）', () => {
  it('error + pending → 仍 error（failed），pendingWakeups 作为事实仍随 outcome 透传', async () => {
    const agent = new Agent({ llm: new ThrowingLLM(), maxTurns: 2 });
    registerShellProvider(agent);

    const outcome = await agent.onCallDetailed('boom');

    expect(outcome.reason).toBe('error');
    expect(outcome.status).toBe('failed');
    expect(outcome.pendingWakeups).toEqual(WAKEUPS);
  });

  it('cancelled + pending → 仍 cancelled', async () => {
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
        return 'partial output before user interrupt';
      },
    };
    const agent = new Agent({ llm: new ToolCallLLM('long'), maxTurns: 5, tools: [longTool] });
    registerShellProvider(agent);

    const callPromise = agent.onCallDetailed('run long tool');
    while (!started) {
      await sleep(2);
    }
    expect(agent.interrupt()).toBe(true);
    const outcome = await callPromise;

    expect(outcome.reason).toBe('cancelled');
    expect(outcome.status).toBe('cancelled');
    expect(outcome.pendingWakeups).toEqual(WAKEUPS);
  });

  it('limit_reached + pending → 仍 limit_reached（不升级为 suspended）', async () => {
    const echoTool: Tool = {
      name: 'echo',
      description: 'Echo tool',
      execute: async () => 'ok',
    };
    const agent = new Agent({ llm: new AlwaysToolCallLLM('echo'), maxTurns: 1, tools: [echoTool] });
    registerShellProvider(agent);

    const outcome = await agent.onCallDetailed('loop forever');

    expect(outcome.reason).toBe('limit_reached');
    expect(outcome.status).toBe('failed');
  });

  it('continuation request 结束的回合 + pending → 仍 continued（continuation 语义优先于改判）', async () => {
    let agentRef!: Agent;
    const checkpointTool: Tool = {
      name: 'checkpoint-tool',
      description: 'Registers a continuation request',
      execute: async () => {
        agentRef.registerContinuationRequest({ kind: 'checkpoint', checkpointId: 'cp-1' });
        return 'registered';
      },
    };
    const agent = new Agent({ llm: new ToolCallLLM('checkpoint-tool'), maxTurns: 5, tools: [] });
    agentRef = agent;
    agent.tools.register(checkpointTool);
    registerShellProvider(agent);

    const outcome = await agent.onCallDetailed('make a checkpoint');

    expect(outcome.reason).toBe('continued');
    expect(outcome.status).toBe('continued');
    expect(outcome.pendingWakeups).toEqual(WAKEUPS);
  });
});

// ========== 事件流：挂起不是失败 ==========

describe('session events：suspended 走 turn.completed 而非 turn.failed', () => {
  it('suspended 回合发 turn.completed（带 suspended 标志与 pendingWakeups），不发 turn.failed', async () => {
    const events: SessionEvent[] = [];
    const unsubscribe = subscribeSessionEvents(e => events.push(e));

    try {
      const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
      registerShellProvider(agent);
      await agent.onCallDetailed('build it');
    } finally {
      unsubscribe();
    }

    const completed = events.filter(e => e.type === 'turn.completed');
    const failed = events.filter(e => e.type === 'turn.failed');
    expect(failed).toHaveLength(0);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: 'turn.completed',
      suspended: true,
      pendingWakeups: WAKEUPS,
    });
  });

  it('真完成回合的 turn.completed 不带 suspended 标志', async () => {
    const events: SessionEvent[] = [];
    const unsubscribe = subscribeSessionEvents(e => events.push(e));

    try {
      const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
      await agent.onCallDetailed('hello');
    } finally {
      unsubscribe();
    }

    const completed = events.filter(e => e.type === 'turn.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).not.toHaveProperty('suspended');
    expect(completed[0]).not.toHaveProperty('pendingWakeups');
  });
});

// ========== pending-work 申报通道 ==========

describe('pending-work 申报通道（registerPendingWorkProvider / collectPendingWakeups）', () => {
  it('多 provider 扇出聚合，异常 provider 按空处理', () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.registerPendingWorkProvider('a', () => [
      { source: 'a', id: 'a-1', summary: 'one' },
      { source: 'a', id: 'a-2', summary: 'two' },
    ]);
    agent.registerPendingWorkProvider('b', () => {
      throw new Error('provider exploded');
    });
    agent.registerPendingWorkProvider('c', () => [
      { source: 'c', id: 'c-1', summary: 'three' },
    ]);

    expect(agent.collectPendingWakeups()).toEqual([
      { source: 'a', id: 'a-1', summary: 'one' },
      { source: 'a', id: 'a-2', summary: 'two' },
      { source: 'c', id: 'c-1', summary: 'three' },
    ]);
  });

  it('同一 source 重复注册以后者覆盖（幂等）', () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.registerPendingWorkProvider('shell', () => [
      { source: 'shell', id: 'old', summary: 'old' },
    ]);
    agent.registerPendingWorkProvider('shell', () => [
      { source: 'shell', id: 'new', summary: 'new' },
    ]);

    expect(agent.collectPendingWakeups()).toEqual([
      { source: 'shell', id: 'new', summary: 'new' },
    ]);
  });

  it('未注册时 collectPendingWakeups 返回空数组（降级现状）', () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    expect(agent.collectPendingWakeups()).toEqual([]);
  });
});

// ========== 决策上下文事实位 ==========

describe('StepFinishDecisionContext.hasPendingWakeups', () => {
  it('申报非空时决策上下文携带 hasPendingWakeups=true', async () => {
    const probe = new StepFinishProbeFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.use(probe as any);
    registerShellProvider(agent);

    await agent.onCallDetailed('build it');

    expect(probe.captured.length).toBeGreaterThan(0);
    expect(probe.captured.every(ctx => ctx.hasPendingWakeups === true)).toBe(true);
  });

  it('未申报时 hasPendingWakeups=false', async () => {
    const probe = new StepFinishProbeFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.use(probe as any);

    await agent.onCallDetailed('hello');

    expect(probe.captured.length).toBeGreaterThan(0);
    expect(probe.captured.every(ctx => ctx.hasPendingWakeups === false)).toBe(true);
  });
});
