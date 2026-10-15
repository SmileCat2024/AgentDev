/**
 * 运行中凭证失效恢复编排测试（ADR-0028）
 *
 * 覆盖：
 * - HTTP 401 auth 错误触发 setModel 重 resolve，并用新 LLM 实例重试成功
 * - thinkingEffort 档位透传到 resolver（省略会静默重置用户运行档位）
 * - 重试仍 auth 错误 → 以 category 'auth_required' 终止，且只恢复一次
 * - setModel 返回 false（resolver 解析失败）→ 'auth_required' 终止，实例不变
 * - onLLMSwap 观察者可见 source 'auth-recovery'
 * - 非 auth 错误（connection_error）不触发恢复，走既有语义
 * - 未注入 modelResolver 时 auth 错误按原语义终止（不抛装配异常）
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import { classifyAndWrapError } from '../src/core/api-errors.js';
import type {
  AgentConfig,
  LLMClient,
  LLMResponse,
  Message,
  ModelPresetResolver,
  LLMMeta,
  ResolvedModelPreset,
  Tool,
} from '../src/core/types.js';

// ========== Mock LLM ==========

type ChatBehavior = () => Promise<LLMResponse>;

class ScriptedLLM implements LLMClient {
  chatCount = 0;

  constructor(
    readonly label: string,
    private behavior: ChatBehavior,
  ) {}

  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.chatCount++;
    return this.behavior();
  }
}

const throwAuth401 = (): ChatBehavior =>
  async () => { throw classifyAndWrapError(new Error('401 Unauthorized'), 401); };

// ========== Mock Resolver ==========

class RecoveryResolver implements ModelPresetResolver {
  calls: Array<{ presetName: string; overrides?: { thinkingEffort?: string | null } }> = [];

  constructor(
    private factory: (index: number, overrides?: { thinkingEffort?: string | null }) => ResolvedModelPreset | null,
  ) {}

  resolve(presetName: string, overrides?: { thinkingEffort?: string | null }): ResolvedModelPreset | null {
    this.calls.push({ presetName, overrides: overrides ? { ...overrides } : undefined });
    return this.factory(this.calls.length - 1, overrides);
  }
}

/** 回显 thinkingEffort 的 resolver：overrides 带档位时写入 meta，模拟真实 resolver 行为 */
function effortEchoFactory(makeLLM: (index: number) => LLMClient) {
  return (index: number, overrides?: { thinkingEffort?: string | null }): ResolvedModelPreset => {
    const meta: LLMMeta = {
      modelName: `model-${index}`,
      presetName: 'p1',
      provider: 'anthropic',
    };
    if (overrides && 'thinkingEffort' in overrides) {
      meta.thinkingEffort = overrides.thinkingEffort ?? null;
    }
    return { llm: makeLLM(index), meta };
  };
}

// ========== Helpers ==========

class TestAgent extends Agent {}

async function runCall(agent: Agent) {
  return agent.onCallDetailed('hi');
}

// ========== Tests ==========

describe('Auth recovery orchestration (ADR-0028)', () => {
  it('should re-resolve via setModel on 401 and succeed with the new LLM instance', async () => {
    const failer = new ScriptedLLM('stale-cred', throwAuth401());
    const succeeder = new ScriptedLLM('fresh-cred', async () => ({ content: 'ok-after-swap' }));
    const resolver = new RecoveryResolver(effortEchoFactory(i => (i === 0 ? failer : succeeder)));
    const agent = new TestAgent({ llm: new ScriptedLLM('boot', async () => ({ content: 'boot' })), name: 'AuthAgent', modelResolver: resolver });
    agent.setModel('p1', { source: 'boot' }); // 建立 presetName 锚点，llm 变为 failer
    expect((agent as any).llm).toBe(failer);

    const outcome = await runCall(agent);

    expect(outcome.status).toBe('completed');
    expect(outcome.response).toBe('ok-after-swap');
    // boot resolve + 恰好一次恢复 resolve（无档位时不传 overrides，按 preset 默认档位重造）
    expect(resolver.calls).toHaveLength(2);
    expect(resolver.calls[1]).toEqual({ presetName: 'p1', overrides: undefined });
    expect((agent as any).llm).toBe(succeeder);
    expect(failer.chatCount).toBe(1);
    expect(succeeder.chatCount).toBe(1);
  });

  it('should forward current thinkingEffort to the resolver during recovery', async () => {
    const failer = new ScriptedLLM('stale-cred', throwAuth401());
    const succeeder = new ScriptedLLM('fresh-cred', async () => ({ content: 'ok' }));
    const resolver = new RecoveryResolver((i, overrides) =>
      effortEchoFactory(() => (i === 0 ? failer : succeeder))(i, overrides));
    const agent = new TestAgent({ llm: new ScriptedLLM('boot', async () => ({ content: 'boot' })), name: 'EffortAgent', modelResolver: resolver });
    agent.setModel('p1', { thinkingEffort: 'high', source: 'boot' });
    expect(agent.getLLMMeta().thinkingEffort).toBe('high');

    const outcome = await runCall(agent);

    expect(outcome.status).toBe('completed');
    // 恢复调用必须带当前运行档位；不带会被按 preset 默认档位重造
    expect(resolver.calls[1]!.overrides).toEqual({ thinkingEffort: 'high' });
    expect(agent.getLLMMeta().thinkingEffort).toBe('high');
  });

  it('should terminate with auth_required (retryable false) and recover only once when retry still fails', async () => {
    const first = new ScriptedLLM('stale-1', throwAuth401());
    const second = new ScriptedLLM('stale-2', throwAuth401());
    const resolver = new RecoveryResolver(effortEchoFactory(i => (i === 0 ? first : second)));
    const agent = new TestAgent({ llm: new ScriptedLLM('boot', async () => ({ content: 'boot' })), name: 'DeadCredAgent', modelResolver: resolver });
    agent.setModel('p1', { source: 'boot' });

    const outcome = await runCall(agent);

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('error');
    expect(outcome.error).toMatchObject({
      category: 'auth_required',
      retryable: false,
      statusCode: 401,
    });
    // 只做一轮恢复：boot + 一次恢复 resolve；每个实例各被调用一次，无第二循环
    expect(resolver.calls).toHaveLength(2);
    expect(first.chatCount).toBe(1);
    expect(second.chatCount).toBe(1);
  });

  it('should terminate with auth_required when setModel returns false (preset unresolvable)', async () => {
    const failer = new ScriptedLLM('stale-cred', throwAuth401());
    const resolver = new RecoveryResolver(effortEchoFactory(() => failer));
    const agent = new TestAgent({ llm: new ScriptedLLM('boot', async () => ({ content: 'boot' })), name: 'ClearedCredAgent', modelResolver: resolver });
    agent.setModel('p1', { source: 'boot' });
    // 凭证已被清理：恢复期 resolve 返回 null
    (resolver as any).factory = () => null;

    const outcome = await runCall(agent);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatchObject({ category: 'auth_required', retryable: false });
    expect((agent as any).llm).toBe(failer); // 模型未变
    expect(failer.chatCount).toBe(1); // 未用旧实例盲目重试
  });

  it('should surface source "auth-recovery" to onLLMSwap observers', async () => {
    const failer = new ScriptedLLM('stale-cred', throwAuth401());
    const succeeder = new ScriptedLLM('fresh-cred', async () => ({ content: 'ok' }));
    const resolver = new RecoveryResolver(effortEchoFactory(i => (i === 0 ? failer : succeeder)));
    const agent = new TestAgent({ llm: new ScriptedLLM('boot', async () => ({ content: 'boot' })), name: 'ObserverAgent', modelResolver: resolver });
    agent.setModel('p1', { source: 'boot' });

    const swaps: Array<{ newLabel: string; oldLabel: string; metaSource?: string }> = [];
    agent.onLLMSwap((newLLM, oldLLM) => {
      swaps.push({
        newLabel: (newLLM as ScriptedLLM).label,
        oldLabel: (oldLLM as ScriptedLLM).label,
        metaSource: agent.getLLMMeta().source,
      });
    });

    const outcome = await runCall(agent);

    expect(outcome.status).toBe('completed');
    expect(swaps).toEqual([{ newLabel: 'fresh-cred', oldLabel: 'stale-cred', metaSource: 'auth-recovery' }]);
  });

  it('should NOT attempt recovery for non-auth errors (connection_error)', async () => {
    const failer = new ScriptedLLM('conn-broken', async () => {
      throw classifyAndWrapError(new Error('fetch failed'));
    });
    const resolver = new RecoveryResolver(effortEchoFactory(() => failer));
    const agent = new TestAgent({ llm: new ScriptedLLM('boot', async () => ({ content: 'boot' })), name: 'ConnAgent', modelResolver: resolver });
    agent.setModel('p1', { source: 'boot' });

    const outcome = await runCall(agent);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatchObject({ category: 'connection_error', retryable: true });
    expect(outcome.error!.category).not.toBe('auth_required');
    expect(resolver.calls).toHaveLength(1); // 仅 boot，无恢复调用
    expect((agent as any).llm).toBe(failer);
  });

  it('should fail with plain auth_error (no recovery, no throw) when no modelResolver injected', async () => {
    const failer = new ScriptedLLM('stale-cred', throwAuth401());
    const agent = new TestAgent({ llm: failer, name: 'BareAgent' });

    const outcome = await runCall(agent);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatchObject({ category: 'auth_error', retryable: false });
  });
});
