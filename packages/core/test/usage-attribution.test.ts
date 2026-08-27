/**
 * 用量模型归因测试（react-loop recordUsage + UsageStats.modelSegments）
 *
 * 覆盖：
 * - call 内 StepStart 中途切换模型：后一个 step 的用量归因到新模型
 * - chat 在途切换（响应返回时 meta 已变）：该次用量仍归因请求发出时的旧模型
 * - 单模型 call：分段聚合为一段，requests / cacheHitRequests 随段累计
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

// ========== Mock LLM ==========

/** 按脚本依次返回响应；每条可携带 usage / toolCalls */
class ScriptedLLM implements LLMClient {
  readonly modelName: string;
  chatCount = 0;

  constructor(modelName: string, private script: Array<Partial<LLMResponse>>) {
    this.modelName = modelName;
  }

  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const item = this.script[Math.min(this.chatCount, this.script.length - 1)];
    this.chatCount++;
    return {
      content: 'ok',
      stopReason: 'end_turn',
      ...item,
    } as LLMResponse;
  }
}

/** 第一次 chat 返回前（在途期间）执行 hook —— 模拟“响应回来时 meta 已变” */
class SwapDuringFlightLLM implements LLMClient {
  readonly modelName = 'model-old';
  chatCount = 0;

  constructor(private onFirstChatInFlight: () => void) {}

  async chat(): Promise<LLMResponse> {
    this.chatCount++;
    if (this.chatCount === 1) {
      this.onFirstChatInFlight();
    }
    return {
      content: 'from model-old',
      stopReason: 'end_turn',
      usage: { inputTokens: 111, outputTokens: 11, totalTokens: 122 },
    };
  }
}

// ========== Mock Feature ==========

interface StepStartContext {
  step: number;
  agent: {
    setLLM(llm: LLMClient, meta?: Record<string, unknown>): void;
  };
}

class MidCallRotator implements AgentFeature {
  readonly name = 'mid-call-rotator';
  static hooks = {
    onStepStart: { lifecycle: 'StepStart', kind: 'observe' as const },
  };

  constructor(private llmB: LLMClient, private atStep: number) {}

  onStepStart(ctx: StepStartContext): void {
    if (ctx.step === this.atStep) {
      ctx.agent.setLLM(this.llmB, { modelName: this.llmB.modelName });
    }
  }
}

// ========== Helpers ==========

class TestAgent extends Agent {}

function makeEchoTool(): Tool {
  return {
    name: 'echo',
    description: 'echo tool',
    execute: async () => 'echo result',
  };
}

// ========== Tests ==========

describe('usage model attribution across mid-call swap', () => {
  it('call 内中途切换模型：各 step 用量按发出时刻的模型分段归因', async () => {
    // Step0 由 llmA 处理（带工具调用），StepStart(1) 切到 llmB，Step1 由 llmB 收尾。
    const llmA = new ScriptedLLM('model-a', [
      {
        content: '',
        stopReason: 'tool_calls' as LLMResponse['stopReason'],
        toolCalls: [{ id: 't1', name: 'echo', arguments: {} }],
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      },
    ]);
    const llmB = new ScriptedLLM('model-b', [
      { content: 'done', usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 } },
    ]);

    const agent = new TestAgent({
      llm: llmA,
      tools: [makeEchoTool()],
      maxTurns: 5,
      name: 'AttributionAgent',
    });
    agent.setLLM(llmA, { modelName: 'model-a' });
    agent.use(new MidCallRotator(llmB, 1));

    await agent.onCall('rotate mid call');

    expect(llmA.chatCount).toBe(1);
    expect(llmB.chatCount).toBe(1);

    const snapshot = agent.getUsage().toSnapshot();
    const segments = snapshot.calls[0]?.modelSegments;
    expect(segments).toHaveLength(2);

    const segA = segments?.find((s) => s.modelName === 'model-a');
    const segB = segments?.find((s) => s.modelName === 'model-b');
    expect(segA?.usage.totalTokens).toBe(110);
    expect(segA?.requests).toBe(1);
    expect(segB?.usage.totalTokens).toBe(220);
    expect(segB?.requests).toBe(1);
  });

  it('chat 在途时 meta 已被替换：该次用量仍归因请求发出时的模型', async () => {
    // swap 发生在第一次 chat 返回之前：响应回来时 agent meta 已指向新模型
    let agentRef: Agent | null = null;
    const llmOld = new SwapDuringFlightLLM(() => {
      (agentRef as unknown as { setLLM: Agent['setLLM'] }).setLLM(
        new ScriptedLLM('model-new', []),
        { modelName: 'model-new' },
      );
    });

    const agent = new TestAgent({ llm: llmOld, maxTurns: 3, name: 'InFlightAgent' });
    agentRef = agent;
    agent.setLLM(llmOld, { modelName: 'model-old' });

    await agent.onCall('swap during flight');

    const segments = agent.getUsage().toSnapshot().calls[0]?.modelSegments;
    expect(segments).toHaveLength(1);
    expect(segments?.[0].modelName).toBe('model-old');
    expect(segments?.[0].usage.inputTokens).toBe(111);
    expect(segments?.[0].requests).toBe(1);
  });

  it('单模型 call：全部 step 聚合为一个分段并累计请求数与缓存命中', async () => {
    const llm = new ScriptedLLM('model-solo', [
      {
        content: '',
        stopReason: 'tool_calls' as LLMResponse['stopReason'],
        toolCalls: [{ id: 't1', name: 'echo', arguments: {} }],
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 5 },
      },
      { content: 'done', usage: { inputTokens: 60, outputTokens: 6, totalTokens: 66, cacheReadTokens: 4 } },
    ]);

    const agent = new TestAgent({
      llm,
      tools: [makeEchoTool()],
      maxTurns: 5,
      name: 'SoloModelAgent',
    });
    agent.setLLM(llm, { modelName: 'model-solo' });

    await agent.onCall('two steps one model');

    const calls = agent.getUsage().toSnapshot().calls;
    const segments = calls[0]?.modelSegments;
    expect(segments).toHaveLength(1);
    expect(segments?.[0].modelName).toBe('model-solo');
    expect(segments?.[0].requests).toBe(2);
    expect(segments?.[0].cacheHitRequests).toBe(2);
    expect(segments?.[0].usage.inputTokens).toBe(160);
  });
});
