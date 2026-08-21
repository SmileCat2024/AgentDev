/**
 * LLM 热切换（setLLM）测试
 *
 * 覆盖：
 * - setLLM 更新 Agent.llm，使后续 onCall 使用新 LLM
 * - L3 卡点修复：setLLM 在 onCall 后调用时同步 ReActLoopRunner 内部引用
 * - setLLM 在首次 onCall 前调用（reactRunner 尚未创建）
 * - Feature.onLLMSwap 钩子触发
 * - onLLMSwap() 回调注册触发
 * - getLLMMeta 返回更新的元数据
 * - setLLM 允许 mid-turn swap（在途请求由旧 Promise 持有，下个 step 用新 LLM）
 * - Feature.onLLMSwap 抛错不阻断 setLLM
 * - setLLM 推送 Overview Snapshot
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

// ========== Mock LLM ==========

class MockLLM implements LLMClient {
  constructor(
    readonly modelName: string,
    private response: string = 'ok',
  ) {}

  chatCount = 0;

  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.chatCount++;
    return { content: this.response };
  }
}

class CountingLLM implements LLMClient {
  readonly modelName: string;
  chatCount = 0;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.chatCount++;
    return { content: `response from ${this.modelName}` };
  }
}

// ========== Mock Feature ==========

class SwapAwareFeature implements AgentFeature {
  readonly name = 'swap-aware';
  swapCalls: Array<{ newLLM: LLMClient; oldLLM: LLMClient }> = [];

  onLLMSwap?(newLLM: LLMClient, oldLLM: LLMClient): void {
    this.swapCalls.push({ newLLM, oldLLM });
  }
}

class ThrowingSwapFeature implements AgentFeature {
  readonly name = 'throwing-swap';

  onLLMSwap?(): void {
    throw new Error('intentional onLLMSwap error');
  }
}

// ========== Helpers ==========

class TestAgent extends Agent {}

// ========== Tests ==========

describe('LLM Hot Swap (setLLM)', () => {
  it('should update this.llm so the next onCall uses the new LLM', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'SwapAgent', maxTurns: 1 });

    // Swap before first onCall (reactRunner not yet created)
    agent.setLLM(llmB, { modelName: 'model-b' });

    await agent.onCall('hello');

    expect(llmA.chatCount).toBe(0);
    expect(llmB.chatCount).toBe(1);
  });

  it('should sync ReActLoopRunner reference (L3 fix) when swapping after first onCall', async () => {
    const llmA = new CountingLLM('model-a');
    const llmB = new CountingLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'L3Agent', maxTurns: 1 });

    // First call: creates reactRunner with llmA
    await agent.onCall('first call');
    expect(llmA.chatCount).toBe(1);
    expect(llmB.chatCount).toBe(0);

    // Swap after reactRunner is created — this is the critical L3 test
    agent.setLLM(llmB, { modelName: 'model-b' });

    // Second call: reactRunner already exists, must use llmB
    await agent.onCall('second call');
    expect(llmA.chatCount).toBe(1); // no increase
    expect(llmB.chatCount).toBe(1); // new LLM used
  });

  it('should fire Feature.onLLMSwap with correct old and new LLM', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');
    const feature = new SwapAwareFeature();

    const agent = new TestAgent({ llm: llmA, name: 'FeatureSwapAgent', maxTurns: 1 }).use(feature);

    agent.setLLM(llmB);

    expect(feature.swapCalls).toHaveLength(1);
    expect((feature.swapCalls[0]!.newLLM as MockLLM).modelName).toBe('model-b');
    expect((feature.swapCalls[0]!.oldLLM as MockLLM).modelName).toBe('model-a');
  });

  it('should fire registered onLLMSwap callbacks', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'CallbackAgent', maxTurns: 1 });

    const calls: Array<{ newModel: string; oldModel: string }> = [];
    agent.onLLMSwap((newLLM, oldLLM) => {
      calls.push({
        newModel: (newLLM as MockLLM).modelName,
        oldModel: (oldLLM as MockLLM).modelName,
      });
    });

    agent.setLLM(llmB, { modelName: 'model-b' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ newModel: 'model-b', oldModel: 'model-a' });
  });

  it('should update getLLMMeta after setLLM with meta', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'MetaAgent', maxTurns: 1 });

    // Before swap, meta is empty
    expect(agent.getLLMMeta()).toEqual({});

    agent.setLLM(llmB, {
      modelName: 'model-b',
      contextLength: 128000,
      compressRatio: 75,
    });

    expect(agent.getLLMMeta()).toEqual({
      modelName: 'model-b',
      contextLength: 128000,
      compressRatio: 75,
    });
  });

  it('should allow swapping during a running onCall (mid-turn swap)', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'RunningAgent', maxTurns: 1 });

    // Simulate running state
    (agent as any)._currentCallInput = 'simulated running';

    // Mid-turn swap should succeed — no throw
    expect(() => agent.setLLM(llmB, { modelName: 'model-b' })).not.toThrow();

    // LLM reference should be updated
    expect((agent as any).llm).toBe(llmB);

    // Clean up
    (agent as any)._currentCallInput = undefined;
  });

  it('should not crash when a Feature.onLLMSwap throws', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');
    const throwingFeature = new ThrowingSwapFeature();

    const agent = new TestAgent({ llm: llmA, name: 'ThrowAgent', maxTurns: 1 }).use(throwingFeature);

    // Should not throw despite feature error
    expect(() => agent.setLLM(llmB)).not.toThrow();
  });

  it('should push Overview Snapshot to debugHub after swap', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'OverviewAgent', maxTurns: 1 });

    // Set up debug infrastructure manually
    let pushedOverview: any = null;
    const mockDebugHub = {
      updateAgentOverview(_agentId: string, overview: any): void {
        pushedOverview = overview;
      },
    };
    (agent as any).debugHub = mockDebugHub;
    (agent as any).debugEnabled = true;
    (agent as any).agentId = 'test-overview-agent';

    agent.setLLM(llmB);

    expect(pushedOverview).not.toBeNull();
    expect(pushedOverview.modelName).toBe('model-b');
  });

  it('should reflect full LLMMeta (contextLength/compressRatio/presetName) in pushed Overview Snapshot', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'MetaOverviewAgent', maxTurns: 1 });

    let pushedOverview: any = null;
    const mockDebugHub = {
      updateAgentOverview(_agentId: string, overview: any): void {
        pushedOverview = overview;
      },
    };
    (agent as any).debugHub = mockDebugHub;
    (agent as any).debugEnabled = true;
    (agent as any).agentId = 'test-meta-overview-agent';

    agent.setLLM(llmB, {
      modelName: 'model-b',
      contextLength: 200000,
      compressRatio: 70,
      presetName: 'big-context',
      thinkingEffort: 'high',
    });

    expect(pushedOverview).not.toBeNull();
    expect(pushedOverview.modelName).toBe('model-b');
    expect(pushedOverview.presetName).toBe('big-context');
    expect(pushedOverview.thinkingEffort).toBe('high');
    expect(pushedOverview.contextLength).toBe(200000);
    expect(pushedOverview.compressRatio).toBe(70);
  });

  it('should omit contextLength/compressRatio from Overview when meta lacks them', async () => {
    const llmA = new MockLLM('model-a');

    const agent = new TestAgent({ llm: llmA, name: 'NoCtxOverviewAgent', maxTurns: 1 });

    let pushedOverview: any = null;
    const mockDebugHub = {
      updateAgentOverview(_agentId: string, overview: any): void {
        pushedOverview = overview;
      },
    };
    (agent as any).debugHub = mockDebugHub;
    (agent as any).debugEnabled = true;
    (agent as any).agentId = 'test-no-ctx-overview-agent';

    // setLLM with only modelName — no contextLength/compressRatio
    agent.setLLM(llmA, { modelName: 'model-a' });

    expect(pushedOverview).not.toBeNull();
    expect(pushedOverview.modelName).toBe('model-a');
    expect(pushedOverview.contextLength).toBeUndefined();
    expect(pushedOverview.compressRatio).toBeUndefined();
  });

  it('should update SystemContext SYSTEM_CURRENT_MODEL when meta.modelName provided', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'SysCtxAgent', maxTurns: 1 });

    // Set system context
    const sysCtx: Record<string, string> = { SYSTEM_CURRENT_MODEL: 'model-a' };
    agent.setSystemContext(sysCtx);

    agent.setLLM(llmB, { modelName: 'model-b' });

    expect(sysCtx.SYSTEM_CURRENT_MODEL).toBe('model-b');
  });

  it('should allow swapping without meta (meta stays unchanged)', async () => {
    const llmA = new MockLLM('model-a');
    const llmB = new MockLLM('model-b');

    const agent = new TestAgent({ llm: llmA, name: 'NoMetaAgent', maxTurns: 1 });

    // First swap with meta
    agent.setLLM(llmB, { modelName: 'model-b', contextLength: 100000 });

    // Second swap without meta — meta should remain from first swap
    const llmC = new MockLLM('model-c');
    agent.setLLM(llmC);

    expect(agent.getLLMMeta()).toEqual({ modelName: 'model-b', contextLength: 100000 });
  });
});
