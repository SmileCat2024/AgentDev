import { describe, it, expect } from 'vitest';
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

class MetadataProbeFeature implements AgentFeature {
  readonly name = 'metadata-probe';
  static hooks: HookDeclarations = {
    onCallStartHook: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };
  captured: Array<CallStartContext | undefined> = [];
  dispatched: Array<{ value: unknown; callIndex: number }> = [];

  async onCallStartHook(ctx: CallStartContext): Promise<void> {
    this.captured.push(ctx);
    if (ctx.metadata && typeof ctx.metadata === 'object') {
      ctx.context.addSystemMessage('metadata seen', (ctx.agent as any)?._callIndex ?? 0, this.name, 'reminder');
    }
  }

  // call 内注入点的消费入口（react-loop 经 dispatchTurnMetadata 派发）
  async onTurnMetadata(value: unknown, { context, agent }: { context: any; agent?: any }): Promise<void> {
    this.dispatched.push({ value, callIndex: (agent as any)?._callIndex ?? 0 });
    context.addSystemMessage('metadata dispatched', (agent as any)?._callIndex ?? 0, this.name, 'reminder');
  }
}

describe('user-turn metadata passthrough to CallStartContext', () => {
  it('delivers free-form metadata to feature CallStart hooks', async () => {
    const probe = new MetadataProbeFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.use(probe as any);

    const metadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-1', title: '修复登录超时' }] };
    await agent.onCall('hello', undefined, undefined, metadata);

    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]!.metadata).toEqual(metadata);
    const reminder = agent.getContext().getAll().find(message => message.content === 'metadata seen');
    expect(reminder).toBeDefined();
    expect(reminder?.tag).toBe('reminder');
  });

  it('omits metadata from hook context when the turn carries none', async () => {
    const probe = new MetadataProbeFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.use(probe as any);

    await agent.onCall('plain turn');

    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]!.metadata).toBeUndefined();
  });

  it('dispatches namespaced metadata to the owning feature handler (in-call entry)', async () => {
    // call 内注入点（react-loop 排队消息）的消费入口：按 key = feature 名派发
    // onTurnMetadata，与 CallStartContext 入口互斥。
    const probe = new MetadataProbeFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.use(probe as any);

    const refs = [{ agentId: 'programming-helper', sessionId: 'session-2', title: '引用' }];
    // 首次 call 前 persistentContext 尚未建立：getContext() 每次返回新实例，
    // 必须持有同一个引用再断言（与 react-loop 的注入点传同一 context 同构）
    const context = agent.getContext();
    await agent.dispatchTurnMetadata({ 'metadata-probe': refs, 'not-mounted': { x: 1 } }, context);

    expect(probe.dispatched).toHaveLength(1);
    expect(probe.dispatched[0].value).toEqual(refs);
    const reminder = context.getAll().find(message => message.content === 'metadata dispatched');
    expect(reminder).toBeDefined();
    expect(reminder?.tag).toBe('reminder');
  });

  it('isolates per-key dispatch failures (one throwing feature does not block the rest)', async () => {
    class ThrowingFeature implements AgentFeature {
      readonly name = 'throwing-meta';
      async onTurnMetadata(): Promise<void> {
        throw new Error('boom');
      }
    }
    const probe = new MetadataProbeFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.use(probe as any);
    agent.use(new ThrowingFeature() as any);

    const context = agent.getContext();
    // throwing key 在前：后续 key 仍被派发，不抛出
    await agent.dispatchTurnMetadata({ 'throwing-meta': { x: 1 }, 'metadata-probe': { y: 2 } }, context);

    expect(probe.dispatched).toHaveLength(1);
    expect(probe.dispatched[0].value).toEqual({ y: 2 });
  });
});
