import { describe, it, expect, afterEach, vi } from 'vitest';
import { Agent } from '../src/core/agent.js';
import { subscribeSessionEvents } from '../src/core/session-events.js';
import type { SessionEvent } from '../src/core/session-events.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';
import type { HookResult, StepFinishedContext } from '../src/core/lifecycle.js';

class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

/** 正向 onStepFinished 钩子直接 end 的 Agent：构造 hook 触发的完成路径。 */
class HookEndAgent extends Agent {
  protected async onStepFinished(_ctx: StepFinishedContext): Promise<HookResult | undefined> {
    return { action: 'end' } as unknown as HookResult;
  }
}

class FailingLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    throw new Error('model exploded');
  }
}

/** 每次都发起工具调用的 LLM：配合 maxTurns=1 构造 limit_reached 终态。 */
class AlwaysToolCallLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return {
      content: '',
      toolCalls: [{ id: 't1', name: 'definitely_not_registered_tool', arguments: {} }],
    };
  }
}

/** 订阅会话事件流并在用例结束后退订（模块级单例，防止跨用例泄漏）。 */
function collectEvents(): { events: SessionEvent[]; unsubscribe: () => void } {
  const events: SessionEvent[] = [];
  const unsubscribe = subscribeSessionEvents((event) => events.push(event));
  return { events, unsubscribe };
}

describe('turn event source identity (ADR-0031 step 1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turn.started / turn.completed carry source and sourceRef from call options', async () => {
    const { events, unsubscribe } = collectEvents();
    try {
      const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
      await agent.onCall('执行任务', undefined, undefined, undefined, {
        source: 'thread',
        sourceRef: 'cmd-abc-1',
      });

      const started = events.find((e) => e.type === 'turn.started');
      expect(started).toBeDefined();
      if (started?.type === 'turn.started') {
        expect(started.turn).toBe(0);
        expect(started.source).toBe('thread');
        expect(started.sourceRef).toBe('cmd-abc-1');
      }

      const completed = events.find((e) => e.type === 'turn.completed');
      expect(completed).toBeDefined();
      if (completed?.type === 'turn.completed') {
        expect(completed.source).toBe('thread');
        expect(completed.sourceRef).toBe('cmd-abc-1');
        // 无 busy 排队消费时不带 consumedSourceRefs（事件形状向后兼容）
        expect(completed.consumedSourceRefs).toBeUndefined();
      }
    } finally {
      unsubscribe();
    }
  });

  it('omits identity fields when call options carry none (backward-compatible shape)', async () => {
    const { events, unsubscribe } = collectEvents();
    try {
      const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
      await agent.onCall('hello');

      const started = events.find((e) => e.type === 'turn.started');
      if (started?.type === 'turn.started') {
        expect('source' in started).toBe(false);
        expect('sourceRef' in started).toBe(false);
      }
      const completed = events.find((e) => e.type === 'turn.completed');
      if (completed?.type === 'turn.completed') {
        expect('source' in completed).toBe(false);
        expect('sourceRef' in completed).toBe(false);
        expect('consumedSourceRefs' in completed).toBe(false);
      }
    } finally {
      unsubscribe();
    }
  });

  it('turn.failed carries sourceRef for a dispatched turn that errored', async () => {
    const { events, unsubscribe } = collectEvents();
    try {
      const agent = new Agent({ llm: new FailingLLM(), maxTurns: 1 });
      await agent.onCall('会失败的输入', undefined, undefined, undefined, {
        source: 'thread',
        sourceRef: 'cmd-fail-1',
      });

      const failed = events.find((e) => e.type === 'turn.failed');
      expect(failed).toBeDefined();
      if (failed?.type === 'turn.failed') {
        expect(failed.source).toBe('thread');
        expect(failed.sourceRef).toBe('cmd-fail-1');
      }
    } finally {
      unsubscribe();
    }
  });

  it('limit_reached reports an unfinished turn with reason and consumed identity (never a completion)', async () => {
    // 预算耗尽：step 边界已注入的排队输入身份随 turn.failed 携带（已消费
    // 身份不丢），事件带 reason；消费端不得把该终态当作任何指令的完成。
    const mailbox = [
      { text: '排队任务', source: 'thread', sourceRef: 'cmd-queued-limit' },
    ];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('/dequeue-input')) {
        return {
          ok: true,
          json: async () => ({ input: mailbox.shift() ?? null, remaining: mailbox.length }),
        };
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { events, unsubscribe } = collectEvents();
    try {
      const agent = new Agent({ llm: new AlwaysToolCallLLM(), maxTurns: 1 });
      await agent.onCall('开始构建', undefined, undefined, undefined, {
        source: 'thread',
        sourceRef: 'cmd-limit-1',
      });

      const failed = events.find((e) => e.type === 'turn.failed');
      expect(failed).toBeDefined();
      if (failed?.type === 'turn.failed') {
        expect(failed.error?.reason).toBe('limit_reached');
        expect(failed.sourceRef).toBe('cmd-limit-1');
        expect(failed.consumedSourceRefs).toEqual(['cmd-queued-limit']);
      }
      // 预算耗尽不产生 turn.completed
      expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
    } finally {
      unsubscribe();
    }
  });
});

describe('busy queued input consumption identity (react-loop drain)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turn.completed carries consumedSourceRefs for busy-injected inputs in injection order', async () => {
    // busy 路径：call 进行/收尾边界 drain 邮箱，排队项身份聚合为
    // consumedSourceRefs 挂到本回合终态（排队项不产生独立 turn）。
    const mailbox = [
      { text: '排队任务 A', source: 'thread', sourceRef: 'cmd-queued-a' },
      { text: '[后台任务 bg-9 已完成]', kind: 'reminder' as const, source: 'shell', sourceRef: 'cmd-queued-reminder' },
      { text: '排队任务 B（无身份）', source: 'thread' },
      { text: '排队任务 C', source: 'thread', sourceRef: 'cmd-queued-c' },
    ];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('/dequeue-input')) {
        return {
          ok: true,
          json: async () => ({ input: mailbox.shift() ?? null, remaining: mailbox.length }),
        };
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { events, unsubscribe } = collectEvents();
    try {
      const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 3 });
      await agent.onCall('开始构建');

      const messages = agent.getContext().getAll();
      expect(messages.some(m => m.role === 'user' && m.content === '排队任务 A')).toBe(true);
      expect(messages.some(m => m.role === 'user' && m.content === '排队任务 C')).toBe(true);

      const completed = events.find((e) => e.type === 'turn.completed');
      expect(completed).toBeDefined();
      if (completed?.type === 'turn.completed') {
        // 只有携带身份且被注入的项进列表；无身份项不进；按注入顺序
        expect(completed.consumedSourceRefs).toEqual([
          'cmd-queued-a',
          'cmd-queued-reminder',
          'cmd-queued-c',
        ]);
      }
    } finally {
      unsubscribe();
    }
  });

  it('discarded resume items do not enter consumedSourceRefs', async () => {
    const mailbox = [
      { text: '', kind: 'resume' as const, source: 'thread', sourceRef: 'cmd-resume-x' },
      { text: '真实排队消息', source: 'thread', sourceRef: 'cmd-queued-real' },
    ];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('/dequeue-input')) {
        return {
          ok: true,
          json: async () => ({ input: mailbox.shift() ?? null, remaining: mailbox.length }),
        };
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { events, unsubscribe } = collectEvents();
    try {
      const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 3 });
      await agent.onCall('开始构建');

      const completed = events.find((e) => e.type === 'turn.completed');
      expect(completed).toBeDefined();
      if (completed?.type === 'turn.completed') {
        // resume 项 busy 消费即弃（不注入），身份不进消费列表
        expect(completed.consumedSourceRefs).toEqual(['cmd-queued-real']);
      }
    } finally {
      unsubscribe();
    }
  });

  it('busy-injected input without sourceRef still continues the loop (no-ref messages are processed)', async () => {
    // 回归锚：injected 判定与 sourceRef 列表必须分离——不带身份的排队消息
    // 注入后同样要 continue 循环交给模型处理，不能因列表为空被跳过。
    let chatCalls = 0;
    const countingLLM: LLMClient = {
      async chat(): Promise<LLMResponse> {
        chatCalls += 1;
        return { content: `reply-${chatCalls}` };
      },
    };
    const mailbox = [
      { text: '无身份排队消息', source: 'thread' },
    ];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('/dequeue-input')) {
        return {
          ok: true,
          json: async () => ({ input: mailbox.shift() ?? null, remaining: mailbox.length }),
        };
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { events, unsubscribe } = collectEvents();
    try {
      const agent = new Agent({ llm: countingLLM, maxTurns: 3 });
      await agent.onCall('开始构建');

      // 消息已注入 context
      const messages = agent.getContext().getAll();
      expect(messages.some(m => m.role === 'user' && m.content === '无身份排队消息')).toBe(true);
      // 注入后续跑了循环：模型在注入后再次被调用（首轮 + 注入后至少一次）
      expect(chatCalls).toBeGreaterThanOrEqual(2);

      const completed = events.find((e) => e.type === 'turn.completed');
      expect(completed).toBeDefined();
      if (completed?.type === 'turn.completed') {
        // 无身份项不进消费身份列表
        expect(completed.consumedSourceRefs).toBeUndefined();
      }
    } finally {
      unsubscribe();
    }
  });

  it('hook-end followed by busy injection and budget exhaustion reports limit_reached, never a false completion', async () => {
    // 回归锚：正向钩子 end 置位 completed 后，若 step 边界 drain 注入了新
    // 排队输入并续跑，预算随即耗尽——终态必须是 limit_reached 的 turn.failed
    // （新输入已消费但未被模型处理），不得带着 completed=true 误报完成。
    const mailbox = [
      { text: '排队任务', source: 'thread', sourceRef: 'cmd-queued-hook' },
    ];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('/dequeue-input')) {
        return {
          ok: true,
          json: async () => ({ input: mailbox.shift() ?? null, remaining: mailbox.length }),
        };
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { events, unsubscribe } = collectEvents();
    try {
      const agent = new HookEndAgent({ llm: new ImmediateLLM(), maxTurns: 1 });
      await agent.onCall('开始构建', undefined, undefined, undefined, {
        source: 'thread',
        sourceRef: 'cmd-hook-1',
      });

      const failed = events.find((e) => e.type === 'turn.failed');
      expect(failed).toBeDefined();
      if (failed?.type === 'turn.failed') {
        expect(failed.error?.reason).toBe('limit_reached');
        expect(failed.sourceRef).toBe('cmd-hook-1');
        expect(failed.consumedSourceRefs).toEqual(['cmd-queued-hook']);
      }
      expect(events.some((e) => e.type === 'turn.completed')).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('exposes identity on the structured CallOutcome for host observers', async () => {
    const mailbox = [
      { text: '排队任务', source: 'thread', sourceRef: 'cmd-queued-o' },
    ];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('/dequeue-input')) {
        return {
          ok: true,
          json: async () => ({ input: mailbox.shift() ?? null, remaining: mailbox.length }),
        };
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    try {
      const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 3 });
      await agent.onCall('开始构建', undefined, undefined, undefined, {
        source: 'thread',
        sourceRef: 'cmd-trigger-1',
      });

      const outcome = agent.getLastCallOutcome();
      expect(outcome).not.toBeNull();
      expect(outcome?.source).toBe('thread');
      expect(outcome?.sourceRef).toBe('cmd-trigger-1');
      expect(outcome?.consumedSourceRefs).toEqual(['cmd-queued-o']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
