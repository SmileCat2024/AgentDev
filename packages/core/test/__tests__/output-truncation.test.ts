import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../../src/core/agent.js';
import { Decision } from '../../src/core/lifecycle.js';
import type { AgentFeature } from '../../src/core/feature.js';
import type { LLMResponse, Message } from '../../src/core/types.js';

function fixture(response: LLMResponse, continueOutput = true) {
  const requests: Message[][] = [];
  const tool = vi.fn(async () => ({ success: true, result: 'executed' }));
  const stepFinish = vi.fn(async (ctx: any) => {
    if (continueOutput && ['max_tokens', 'length'].includes(ctx.llmResponse.stopReason)) {
      ctx.context.add({ role: 'system', content: 'Continue the truncated body.' });
      return Decision.Approve;
    }
    return Decision.Continue;
  });
  class Continuation implements AgentFeature {
    name = 'continuation-test';
    static hooks = { stepFinish: { lifecycle: 'StepFinish' as any, kind: 'guard' as const, role: 'advisor' as const } };
    stepFinish = stepFinish;
  }
  const agent = new Agent({
    llm: { chat: async (messages: Message[]) => {
      requests.push(structuredClone(messages));
      return requests.length === 1 ? response : { content: 'done', stopReason: 'stop' };
    } },
    maxTurns: 3,
    tools: [{ name: 'write', description: 'write', parameters: {}, execute: tool }],
  }).use(new Continuation());
  return { agent, requests, tool, stepFinish };
}

describe('output truncation boundaries', () => {
  for (const stopReason of ['max_tokens', 'length']) {
    it(`${stopReason}: preserves body and thinking, discards every tool call before hooks and the next request`, async () => {
      const response: LLMResponse = {
        content: 'partial body', reasoning: 'visible reasoning',
        thinkingBlocks: [{ type: 'thinking', thinking: 'thought', signature: 'sig' }],
        stopReason,
        toolCalls: [
          { id: 'a', name: 'write', arguments: { path: 'valid-looking' } },
          { id: 'b', name: 'write', arguments: {} },
        ],
      };
      const { agent, requests, tool, stepFinish } = fixture(response);
      await agent.onCall('go');
      expect(tool).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
      const partial = requests[1].find(m => m.content === 'partial body')!;
      expect(partial).toMatchObject({ reasoning: response.reasoning, thinkingBlocks: response.thinkingBlocks });
      expect(partial.toolCalls).toBeUndefined();
      expect(requests[1].some(m => m.role === 'tool')).toBe(false);
      expect(stepFinish.mock.calls[0][0].toolCallsCount).toBe(0);
      expect(agent.getLastCallOutcome()?.status).toBe('completed');
    });

    it(`${stopReason}: reasoning-only truncation is an error, not a continuation candidate`, async () => {
      const { agent, requests, stepFinish } = fixture({ content: '', reasoning: 'thought only', stopReason });
      await agent.onCall('go');
      expect(requests).toHaveLength(1);
      expect(stepFinish).not.toHaveBeenCalled();
      expect(agent.getLastCallOutcome()).toMatchObject({
        status: 'failed', reason: 'error',
        error: { category: 'output_truncated', retryable: false },
      });
    });

    it(`${stopReason}: tools without body never execute or auto-retry`, async () => {
      const { agent, requests, tool, stepFinish } = fixture({
        content: '  ', stopReason,
        toolCalls: [{ id: 'a', name: 'write', arguments: { path: 'valid-looking' } }],
      });
      await agent.onCall('go');
      expect(tool).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(stepFinish).not.toHaveBeenCalled();
      expect(agent.getLastCallOutcome()?.error?.retryable).toBe(false);
    });

    it(`${stopReason}: disabled recovery preserves text but ends as a failure`, async () => {
      const { agent, requests, tool } = fixture({ content: 'partial body', stopReason }, false);
      await agent.onCall('go');
      expect(requests).toHaveLength(1);
      expect(tool).not.toHaveBeenCalled();
      expect(agent.getContext().getAll().some(m => m.content === 'partial body')).toBe(true);
      expect(agent.getLastCallOutcome()).toMatchObject({ status: 'failed', error: { retryable: false } });
    });
  }

  it('ordinary tool responses still execute normally', async () => {
    const { agent, tool } = fixture({
      content: 'working', stopReason: 'tool_use',
      toolCalls: [{ id: 'a', name: 'write', arguments: {} }],
    });
    await agent.onCall('go');
    expect(tool).toHaveBeenCalledOnce();
    expect(agent.getLastCallOutcome()?.status).toBe('completed');
  });
});
