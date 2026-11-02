import { describe, it, expect } from 'vitest';
import { Agent, CallAdmissionDeniedError } from '../src/index.js';
import { CoreLifecycle, Decision } from '../src/core/lifecycle.js';
import type { HookDeclarations } from '../src/core/hook-declarations.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { CallOutcome, LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

class AdmissionFeature implements AgentFeature {
  readonly name = 'admission-test';
  static hooks: HookDeclarations = {
    admit: { lifecycle: CoreLifecycle.PreCallStart, kind: 'guard' },
  };
  seen: Array<{ input: string; kind: string | undefined }> = [];
  deny = true;

  admit(ctx: any) {
    this.seen.push({ input: ctx.input, kind: ctx.options?.kind });
    return this.deny ? { action: Decision.Deny, reason: 'held for user' } : Decision.Continue;
  }
}

describe('PreCallStart admission', () => {
  it('denies before call side effects and leaves the previous outcome intact', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    const feature = new AdmissionFeature();
    agent.use(feature as any);

    await expect(agent.onCallDetailed('machine notice', undefined, undefined, undefined, {
      kind: 'reminder', source: 'shell',
    })).rejects.toMatchObject({
      name: 'CallAdmissionDeniedError',
      code: 'call_admission_denied',
      reason: 'held for user',
    });
    expect(agent._callIndex).toBe(-1);
    expect(agent.getContext().getAll()).toEqual([]);
    expect(agent.getLastCallOutcome()).toBeNull();
    expect(feature.seen).toEqual([{ input: 'machine notice', kind: 'reminder' }]);
  });

  it('executes normally after admission and does not run admission twice', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    const feature = new AdmissionFeature();
    agent.use(feature as any);

    feature.deny = false;
    const outcome: CallOutcome = await agent.onCallDetailed('human input');
    expect(outcome.status).toBe('completed');
    expect(agent._callIndex).toBe(0);
    expect(feature.seen).toEqual([{ input: 'human input', kind: undefined }]);
  });

  it('runs the host start callback only after admission succeeds', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    const feature = new AdmissionFeature();
    agent.use(feature as any);
    const events: string[] = [];

    await expect(agent.onCallDetailed('held', undefined, undefined, undefined, { kind: 'reminder' }, {
      onAdmitted() { events.push('admitted'); },
    })).rejects.toBeInstanceOf(CallAdmissionDeniedError);
    expect(events).toEqual([]);

    feature.deny = false;
    await agent.onCallDetailed('accepted', undefined, undefined, undefined, undefined, {
      onAdmitted() { events.push('admitted'); },
    });
    expect(events).toEqual(['admitted']);
  });

  it('propagates a distinct exported admission error through onCall', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    agent.use(new AdmissionFeature() as any);
    await expect(agent.onCall('machine notice')).rejects.toBeInstanceOf(CallAdmissionDeniedError);
  });
});
