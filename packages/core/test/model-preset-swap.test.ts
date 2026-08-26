/**
 * Model preset swap（setModel / setThinkingEffort）测试
 *
 * 覆盖：
 * - setModel 编排：resolver.resolve → setLLM → meta 贴标（含 source）
 * - setModel 解析失败返回 false，模型不变
 * - setModel 未注入 modelResolver 时抛出（装配缺失显式失败）
 * - thinkingEffort 覆盖传递（含 null 清档）
 * - setThinkingEffort 按当前 presetName 重 resolve；无 presetName 返回 false
 * - Feature.onLLMSwap 钩子触发（宿主与 Feature 消费同一入口）
 * - BasicAgent 透传 modelResolver（白名单重组不得丢弃该字段）
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import { BasicAgent } from '../src/agents/system/BasicAgent.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, ModelPresetResolver, LLMMeta, Tool } from '../src/core/types.js';

// ========== Mock LLM ==========

class MockLLM implements LLMClient {
  constructor(
    readonly modelName: string,
  ) {}

  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'ok' };
  }
}

// ========== Mock Resolver ==========

class MockResolver implements ModelPresetResolver {
  calls: Array<{ presetName: string; overrides?: { thinkingEffort?: string | null } }> = [];
  unknownNames = new Set(['missing-preset']);

  constructor(private effortEcho: string | null | undefined = undefined) {}

  resolve(presetName: string, overrides?: { thinkingEffort?: string | null }) {
    this.calls.push({ presetName, overrides: { ...overrides } });
    if (this.unknownNames.has(presetName)) return null;
    const meta: LLMMeta = {
      modelName: `${presetName}-model`,
      presetName,
      provider: 'anthropic',
    };
    if (this.effortEcho !== undefined || overrides?.thinkingEffort !== undefined) {
      meta.thinkingEffort = overrides && 'thinkingEffort' in overrides
        ? (overrides.thinkingEffort ?? null)
        : (this.effortEcho ?? null);
    }
    return { llm: new MockLLM(meta.modelName!), meta };
  }
}

// ========== Mock Feature ==========

class SwapAwareFeature implements AgentFeature {
  readonly name = 'swap-aware';
  swapCount = 0;

  onLLMSwap?(): void {
    this.swapCount++;
  }
}

// ========== Helpers ==========

class TestAgent extends Agent {}

// ========== Tests ==========

describe('Model preset swap (setModel / setThinkingEffort)', () => {
  it('should resolve via injected resolver and update llm + meta', () => {
    const initialLLM = new MockLLM('boot-model');
    const resolver = new MockResolver();
    const agent = new TestAgent({ llm: initialLLM, name: 'PresetAgent', modelResolver: resolver });

    const ok = agent.setModel('big-model', { source: 'user' });

    expect(ok).toBe(true);
    expect(resolver.calls).toEqual([{ presetName: 'big-model', overrides: {} }]);
    expect((agent as any).llm).not.toBe(initialLLM);
    expect((agent as any).llm.modelName).toBe('big-model-model');
    expect(agent.getLLMMeta()).toMatchObject({
      modelName: 'big-model-model',
      presetName: 'big-model',
      provider: 'anthropic',
      source: 'user',
    });
  });

  it('should return false and keep the current llm when preset resolution fails', () => {
    const initialLLM = new MockLLM('boot-model');
    const resolver = new MockResolver();
    const agent = new TestAgent({ llm: initialLLM, name: 'FailAgent', modelResolver: resolver });

    const ok = agent.setModel('missing-preset');

    expect(ok).toBe(false);
    expect((agent as any).llm).toBe(initialLLM);
  });

  it('should throw when no modelResolver injected', () => {
    const agent = new TestAgent({ llm: new MockLLM('boot-model'), name: 'BareAgent' });

    expect(() => agent.setModel('any')).toThrowError(/modelResolver/);
  });

  it('should forward thinkingEffort override to the resolver (null clears)', () => {
    const resolver = new MockResolver();
    const agent = new TestAgent({ llm: new MockLLM('boot-model'), name: 'EffortAgent', modelResolver: resolver });

    agent.setModel('big-model', { thinkingEffort: 'high' });
    expect(resolver.calls[0]!.overrides).toEqual({ thinkingEffort: 'high' });

    agent.setModel('big-model', { thinkingEffort: null });
    expect(resolver.calls[1]!.overrides).toEqual({ thinkingEffort: null });

    // No thinkingEffort key → no overrides passed
    agent.setModel('big-model');
    expect(resolver.calls[2]!.overrides).toEqual({});
  });

  it('setThinkingEffort should re-resolve the current preset with the effort override', () => {
    const resolver = new MockResolver();
    const agent = new TestAgent({ llm: new MockLLM('boot-model'), name: 'ThinkingAgent', modelResolver: resolver });

    agent.setModel('big-model', { source: 'boot' });
    const ok = agent.setThinkingEffort('low', { source: 'user' });

    expect(ok).toBe(true);
    expect(resolver.calls[1]).toEqual({ presetName: 'big-model', overrides: { thinkingEffort: 'low' } });
    expect(agent.getLLMMeta()).toMatchObject({ presetName: 'big-model', thinkingEffort: 'low', source: 'user' });
  });

  it('setThinkingEffort should return false when current meta has no presetName', () => {
    const resolver = new MockResolver();
    const agent = new TestAgent({ llm: new MockLLM('boot-model'), name: 'AnonymousAgent', modelResolver: resolver });

    // No setModel called → meta empty → nothing to anchor the re-resolve
    expect(agent.setThinkingEffort('high')).toBe(false);
  });

  it('should fire Feature.onLLMSwap (same entry as host-side swaps)', () => {
    const resolver = new MockResolver();
    const feature = new SwapAwareFeature();
    const agent = new TestAgent({ llm: new MockLLM('boot-model'), name: 'FeatureAgent', modelResolver: resolver })
      .use(feature);

    agent.setModel('big-model');

    expect(feature.swapCount).toBe(1);
  });

  it('BasicAgent should forward modelResolver to super (whitelist reassembly must not drop it)', () => {
    const resolver = new MockResolver();
    const agent = new BasicAgent({ llm: new MockLLM('boot-model'), name: 'Basic', workspaceDir: process.cwd(), modelResolver: resolver });

    // 未透传时此处抛 "setModel: no modelResolver injected"（曾致宿主 runtime 闪退）
    const ok = agent.setModel('big-model', { source: 'user' });

    expect(ok).toBe(true);
    expect(agent.getLLMMeta()).toMatchObject({ presetName: 'big-model', source: 'user' });
  });
});
