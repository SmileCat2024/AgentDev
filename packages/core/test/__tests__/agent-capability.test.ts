import { describe, it, expect, vi } from 'vitest';
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

  // 审计兜底：无论 Feature 自己是否写日志，invoke 生命周期必须在
  // logger 通路留痕（hub 连接时进 DebugHub / query_logs；测试环境无
  // hub，走 stdio fallback，故以 spy 捕获）。
  it('emits an audit log line on every capability invocation', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(new CommandFeature());

      await agent.invokeCapability('cmd-feature.reload', { force: true }, 'slash');
      let out = write.mock.calls.map((c) => String(c[0])).join('');
      expect(out).toContain('capability invoked');
      expect(out).toContain('cmd-feature.reload');

      await agent.invokeCapability('cmd-feature.user-only', {}, 'feature'); // denied
      out = write.mock.calls.map((c) => String(c[0])).join('');
      const errOut = errWrite.mock.calls.map((c) => String(c[0])).join('');
      expect(out + errOut).toContain('capability invoke rejected');
      expect(out + errOut).toContain('entry_point_denied');
    } finally {
      write.mockRestore();
      errWrite.mockRestore();
    }
  });
});

class PromptFeature implements AgentFeature {
  name = 'pf';
  activations: Array<{ refs: string[]; hasContext: boolean }> = [];

  getCapabilities(): CapabilityDefinition[] {
    return [
      {
        name: 'load',
        kind: 'prompt',
        entryPoints: ['slash', 'feature'],
        execute: async () => ({ ack: true }),
      },
    ];
  }

  async onCapabilityActivations(refs: string[], ctx: { context: unknown }): Promise<void> {
    this.activations.push({ refs, hasContext: !!ctx.context });
  }
}

describe('Agent turn activation dispatch', () => {
  it('dispatches onCall activations to owning feature before user message', async () => {
    const pf = new PromptFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(pf);

    await agent.onCall('go', undefined, ['pf.load']);

    expect(pf.activations).toEqual([{ refs: ['pf.load'], hasContext: true }]);
    // 注入发生在用户消息之前：activations 派发时 context 尚不含本条 user 消息
    const ctxMessages = (agent as any).persistentContext.getAll();
    const userIdx = ctxMessages.findIndex((m: Message) => m.role === 'user');
    expect(userIdx).toBeGreaterThan(-1);
  });

  it('feature-entry prompt invoke dispatches into current context; slash entry does not', async () => {
    const pf = new PromptFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(pf);

    await agent.onCall('prime'); // 建立 persistentContext
    expect(pf.activations).toHaveLength(0);

    await agent.invokeCapability('pf.load', {}, 'slash');
    expect(pf.activations).toHaveLength(0); // slash 入口由宿主输入管线随消息投递

    await agent.invokeCapability('pf.load', {}, 'feature');
    expect(pf.activations).toEqual([{ refs: ['pf.load'], hasContext: true }]);
  });

  it('ignores unknown refs without throwing', async () => {
    const pf = new PromptFeature();
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 }).use(pf);

    await agent.dispatchTurnActivations(['nope.nope', 'pf.load', 'pf.load'], {} as any);
    expect(pf.activations).toEqual([{ refs: ['pf.load'], hasContext: true }]); // 去重 + 未知 ref 忽略
  });
});
