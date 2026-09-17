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

  async onCallStartHook(ctx: CallStartContext): Promise<void> {
    this.captured.push(ctx);
    if (ctx.metadata && typeof ctx.metadata === 'object') {
      ctx.context.addSystemMessage('metadata seen', (ctx.agent as any)?._callIndex ?? 0, this.name, 'reminder');
    }
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
});
