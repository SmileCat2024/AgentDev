import { describe, it, expect, afterEach, vi } from 'vitest';
import { Agent } from '../src/core/agent.js';
import { CoreLifecycle } from '../src/core/lifecycle.js';
import type { HookDeclarations } from '../src/core/hook-declarations.js';
import type { AgentFeature, FeatureInitContext } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';
import type { CallStartContext } from '../src/core/lifecycle.js';

class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

class CallStartProbeFeature implements AgentFeature {
  readonly name = 'call-start-probe';
  static hooks: HookDeclarations = {
    onCallStartHook: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };
  captured: Array<CallStartContext | undefined> = [];

  async onCallStartHook(ctx: CallStartContext): Promise<void> {
    this.captured.push(ctx);
  }
}

describe('onCall turn identity (kind: user | reminder)', () => {
  it('lands a reminder turn as a sourced system message instead of a user message', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });

    await agent.onCall(
      '[后台任务 bg-1 已完成]\n命令: npm test\n退出码: 0',
      undefined,
      undefined,
      undefined,
      { kind: 'reminder', source: 'shell' },
    );

    const messages = agent.getContext().getAll();
    const reminder = messages.find(m => m.content.startsWith('[后台任务'));
    expect(reminder).toBeDefined();
    expect(reminder?.role).toBe('system');
    expect(reminder?.source).toBe('shell');
    // 不再伪装成用户发言
    expect(messages.some(m => m.role === 'user')).toBe(false);
  });

  it('keeps the default user landing for turns without options', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });

    await agent.onCall('hello');

    const messages = agent.getContext().getAll();
    expect(messages.some(m => m.role === 'user' && m.content === 'hello')).toBe(true);
  });

  it('keeps kind=user explicit turns on the user path', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });

    await agent.onCall('hello', undefined, undefined, undefined, { kind: 'user' });

    const messages = agent.getContext().getAll();
    expect(messages.some(m => m.role === 'user' && m.content === 'hello')).toBe(true);
    expect(messages.some(m => m.role === 'system' && m.source)).toBe(false);
  });

  it('still fires CallStart hooks for a reminder-triggered call', async () => {
    const probe = new CallStartProbeFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.use(probe as any);

    await agent.onCall('[后台任务 bg-1 运行中]', undefined, undefined, undefined, { kind: 'reminder', source: 'shell' });

    // call 机器全套复用：钩子照常生效
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]!.input).toBe('[后台任务 bg-1 运行中]');
  });

  it('round-trips the reminder message through context serialization', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    await agent.onCall('[后台任务 bg-1 已完成]', undefined, undefined, undefined, { kind: 'reminder', source: 'shell' });

    const snapshot = agent.getContext().toJSON();
    const restored = Array.isArray(snapshot) ? snapshot : (snapshot as any).messages ?? snapshot;
    const flat = JSON.parse(JSON.stringify(restored)) as Message[];
    const reminder = flat.find(m => m.content === '[后台任务 bg-1 已完成]');
    expect(reminder).toMatchObject({ role: 'system', source: 'shell' });
  });
});

describe('in-call queued reminder injection (react-loop step-boundary drain)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('injects a busy-time reminder as a sourced system message, not a user message', async () => {
    // busy 路径主链路：call 运行/收尾边界 drain 邮箱，reminder 项必须以
    // system+source 落地（与后续 tool result 合流到下一个 wire 级 user turn）
    const mailbox = [
      { text: '[后台任务 bg-9 已完成]', kind: 'reminder' as const, source: 'shell' },
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

    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 3 });
    await agent.onCall('开始构建');

    const messages = agent.getContext().getAll();
    const reminder = messages.find(m => m.content === '[后台任务 bg-9 已完成]');
    expect(reminder).toBeDefined();
    expect(reminder?.role).toBe('system');
    expect(reminder?.source).toBe('shell');
    // 排队注入不新增 user 消息（call 内注入语义）
    expect(messages.filter(m => m.role === 'user')).toHaveLength(1);
  });
});
