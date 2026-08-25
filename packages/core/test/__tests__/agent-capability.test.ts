import { describe, it, expect } from 'vitest';
import { Agent } from '../../src/core/agent.js';
import type { AgentFeature } from '../../src/core/feature.js';
import type { CapabilityDefinition } from '../../src/core/capability.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../../src/core/types.js';

class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

class CommandFeature implements AgentFeature {
  name = 'cmd-feature';
  executedArgs: Array<Record<string, unknown>> = [];

  getCapabilities(): CapabilityDefinition[] {
    return [
      {
        name: 'reload',
        title: 'Reload',
        entryPoints: ['slash', 'feature'],
        execute: async (args) => {
          this.executedArgs.push(args);
          return 'reloaded';
        },
      },
      {
        name: 'user-only',
        entryPoints: ['slash'],
        execute: async () => 'from-slash',
      },
    ];
  }
}

describe('Agent capability integration', () => {
  it('collects feature capabilities after initialization and snapshots them', async () => {
    const feature = new CommandFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(feature);

    const snapshot = await agent.getCapabilitySnapshot();
    expect(snapshot.map((s) => s.ref).sort()).toEqual(['cmd-feature.reload', 'cmd-feature.user-only']);

    const slashSnapshot = await agent.getCapabilitySnapshot({ entryPoint: 'slash' });
    expect(slashSnapshot.map((s) => s.ref).sort()).toEqual(['cmd-feature.reload', 'cmd-feature.user-only']);

    const featureSnapshot = await agent.getCapabilitySnapshot({ entryPoint: 'feature' });
    expect(featureSnapshot.map((s) => s.ref)).toEqual(['cmd-feature.reload']);
  });

  it('invokes capability from feature entry point and passes args', async () => {
    const feature = new CommandFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(feature);

    const res = await agent.invokeCapability('cmd-feature.reload', { force: true }, 'feature');
    expect(res).toEqual({ ok: true, result: 'reloaded' });
    expect(feature.executedArgs).toEqual([{ force: true }]);
  });

  it('denies slash-only capability invoked via feature entry point', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(new CommandFeature());
    const res = await agent.invokeCapability('cmd-feature.user-only', {}, 'feature');
    expect(res).toMatchObject({ ok: false, code: 'entry_point_denied' });
  });

  it('invokes slash-only capability via slash entry point', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(new CommandFeature());
    const res = await agent.invokeCapability('cmd-feature.user-only', {}, 'slash');
    expect(res).toEqual({ ok: true, result: 'from-slash' });
  });

  it('allows slash entry point on dual-entry capability', async () => {
    const feature = new CommandFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(feature);
    const res = await agent.invokeCapability('cmd-feature.reload', {}, 'slash');
    expect(res).toEqual({ ok: true, result: 'reloaded' });
    expect(feature.executedArgs).toEqual([{}]);
  });
});
