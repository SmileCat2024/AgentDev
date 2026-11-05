/**
 * interrupt(cause) 打断原因透传（CallOutcome.interruptedBy）
 *
 * 覆盖：
 * - 带 cause 打断 → cancelled outcome 原样携带 interruptedBy（宿主自有词汇，
 *   框架不解释）
 * - 无 cause 打断 → outcome 不携带 interruptedBy 字段（现状行为不变）
 * - cause 是 per-call 瞬态：上一笔申报不泄漏到后续 call 的 outcome
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../../src/core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool, ToolExecutionContext } from '../../src/core/types.js';

// ========== Mock ==========

/** 首轮发起工具调用；上下文已有工具结果时自然收尾。 */
class ToolCallLLM implements LLMClient {
  async chat(messages: Message[]): Promise<LLMResponse> {
    const hasToolResults = messages.some(m => m.role === 'tool');
    if (!hasToolResults) {
      return {
        content: 'Calling hold.',
        toolCalls: [{ id: 'tc_1', name: 'hold', arguments: {} }],
      };
    }
    return { content: 'Done.' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeInterruptibleAgent(): { agent: Agent; started: () => Promise<void> } {
  let started = false;
  const holdTool: Tool = {
    name: 'hold',
    description: 'Holds until aborted',
    execute: async (_args, ctx?: ToolExecutionContext) => {
      started = true;
      while (!ctx?.signal?.aborted) {
        await sleep(5);
      }
      return 'partial output';
    },
  };
  return {
    agent: new Agent({ llm: new ToolCallLLM(), maxTurns: 5, name: 'InterruptCauseTestAgent', tools: [holdTool] }),
    started: async () => {
      while (!started) await sleep(2);
    },
  };
}

// ========== 测试用例 ==========

describe('interrupt(cause) → CallOutcome.interruptedBy', () => {
  it('带 cause 打断：cancelled outcome 原样携带 interruptedBy', async () => {
    const { agent, started } = makeInterruptibleAgent();
    const callPromise = agent.onCallDetailed('run');
    await started();
    expect(agent.interrupt('context_rotation')).toBe(true);
    const outcome = await callPromise;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.interruptedBy).toBe('context_rotation');
  });

  it('无 cause 打断：outcome 不携带 interruptedBy 字段（现状行为不变）', async () => {
    const { agent, started } = makeInterruptibleAgent();
    const callPromise = agent.onCallDetailed('run');
    await started();
    expect(agent.interrupt()).toBe(true);
    const outcome = await callPromise;
    expect(outcome.status).toBe('cancelled');
    expect('interruptedBy' in outcome).toBe(false);
  });

  it('cause 是 per-call 瞬态：带因打断后的下一次自然完成不带 interruptedBy', async () => {
    const { agent, started } = makeInterruptibleAgent();
    const firstCall = agent.onCallDetailed('run');
    await started();
    expect(agent.interrupt('context_rotation')).toBe(true);
    const firstOutcome = await firstCall;
    expect(firstOutcome.interruptedBy).toBe('context_rotation');

    // 同一 agent 再跑一轮：上下文已含工具结果，LLM 直接收尾（无工具调用、
    // 无打断）→ completed 且无 interruptedBy 残留。
    const secondOutcome = await agent.onCallDetailed('run again');
    expect(secondOutcome.status).toBe('completed');
    expect('interruptedBy' in secondOutcome).toBe(false);
  });
});
