/**
 * RestoreOrigin 贯通 + 延迟模型绑定 + FeatureInitContext.modelControl 测试
 * （ADR-0034 §1 框架契约）
 *
 * 覆盖：
 * - restoreState 第二参：五类恢复入口传正确 origin
 *   （session-revive / rollback×3 / hot-reload；continuity-import 与
 *   branch-import 由宿主显式传入，经 restoreFeatureSnapshots 直测）
 * - 旧签名 Feature（不接第二参）在恢复入口下行为不变
 * - llm 缺省构造：可构造、可恢复状态；未绑定 onCall 抛错；绑定后正常
 * - FeatureInitContext.modelControl 转发行为与 Agent 直调一致
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { Agent } from '../src/core/agent.js';
import { createStepCheckpoint, rollbackToStepCheckpoint, restoreFeatureSnapshots } from '../src/core/checkpoint.js';
import type { AgentFeature, FeatureInitContext, FeatureModelControl, RestoreContext, RestoreOrigin } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, ModelPresetResolver, LLMMeta, Tool } from '../src/core/types.js';

// ========== Mocks ==========

class EchoLLM implements LLMClient {
  constructor(readonly modelName: string = 'echo-model') {}
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    return { content: `reply:${lastUser}` };
  }
}

class MockResolver implements ModelPresetResolver {
  calls: Array<{ presetName: string; overrides?: { thinkingEffort?: string | null } }> = [];
  unknownNames = new Set(['missing-preset']);
  resolve(presetName: string, overrides?: { thinkingEffort?: string | null }) {
    this.calls.push({ presetName, overrides: { ...overrides } });
    if (this.unknownNames.has(presetName)) return null;
    const meta: LLMMeta = { modelName: `${presetName}-model`, presetName, provider: 'anthropic' };
    if (overrides && 'thinkingEffort' in overrides) meta.thinkingEffort = overrides.thinkingEffort ?? null;
    return { llm: new EchoLLM(meta.modelName!), meta };
  }
}

/** 记录 restoreState 收到的完整实参（含第二参 origin） */
class OriginSpyFeature implements AgentFeature {
  readonly name: string;
  state = 0;
  restoreCalls: Array<{ snapshot: unknown; ctx?: RestoreContext }> = [];
  initModelControl?: FeatureModelControl;
  initModelControlCount = 0;

  constructor(name = 'origin-spy') {
    this.name = name;
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.initModelControl = ctx.modelControl;
    this.initModelControlCount += 1;
  }

  captureState(): { state: number } {
    return { state: this.state };
  }

  restoreState(snapshot: unknown, ctx?: RestoreContext): void {
    this.restoreCalls.push({ snapshot, ctx });
    this.state = (snapshot as { state: number }).state;
  }

  get lastOrigin(): RestoreOrigin | undefined {
    return this.restoreCalls[this.restoreCalls.length - 1]?.ctx?.origin;
  }
}

/** 旧签名 Feature：不声明第二参（编译期兼容运行期忽略） */
class LegacySignatureFeature implements AgentFeature {
  readonly name = 'legacy-sig';
  counter = 0;
  restoreCount = 0;

  captureState(): { counter: number } {
    return { counter: this.counter };
  }

  restoreState(snapshot: unknown): void {
    this.restoreCount += 1;
    this.counter = (snapshot as { counter: number }).counter;
  }
}

class TestAgent extends Agent {
  constructor(feature: AgentFeature, llm?: LLMClient, modelResolver?: ModelPresetResolver) {
    super({
      ...(llm ? { llm } : {}),
      maxTurns: 2,
      name: 'RestoreOriginAgent',
      systemMessage: 'restore origin test',
      ...(modelResolver ? { modelResolver } : {}),
    });
    this.use(feature);
  }
  get callCheckpointsAccessor(): Array<Record<string, unknown>> {
    return (this as unknown as { _callCheckpoints: Array<Record<string, unknown>> })._callCheckpoints;
  }
}

// ========== origin 断言（五入口） ==========

describe('restoreState origin 贯通', () => {
  it('restoreSessionSnapshot → session-revive', async () => {
    const spy = new OriginSpyFeature();
    spy.state = 5;
    const agent = new TestAgent(spy, new EchoLLM());
    await agent.onCall('first'); // 建立会话状态

    const snapshot = await agent.createSessionSnapshot('s1');
    spy.state = 99; // 后续变更，恢复应覆盖
    spy.restoreCalls.length = 0;

    await agent.restoreSessionSnapshot(snapshot);
    expect(spy.lastOrigin).toEqual({ kind: 'session-revive' });
    expect(spy.state).toBe(5);
  });

  it('rollbackToCall（v2 context-boundary）→ rollback', async () => {
    const spy = new OriginSpyFeature();
    const agent = new TestAgent(spy, new EchoLLM());
    await agent.onCall('first');
    await agent.onCall('second');
    spy.restoreCalls.length = 0;

    await agent.rollbackToCall(1);
    expect(spy.lastOrigin).toEqual({ kind: 'rollback' });
  });

  it('rollbackToCall（v1 legacy-full-snapshot）→ rollback', async () => {
    const spy = new OriginSpyFeature();
    const agent = new TestAgent(spy, new EchoLLM());
    await agent.onCall('first');

    // 手工注入 legacy checkpoint（现行代码只创建 v2；v1 来自旧会话快照）
    const runtime = await agent.createSessionSnapshot('legacy');
    agent.callCheckpointsAccessor.push({
      kind: 'legacy-full-snapshot',
      callIndex: 0.5,
      draftInput: 'legacy-input',
      runtime: runtime.runtime,
    });
    spy.restoreCalls.length = 0;

    const rollback = await agent.rollbackToCall(0.5);
    expect(rollback.draftInput).toBe('legacy-input');
    expect(spy.lastOrigin).toEqual({ kind: 'rollback' });
  });

  it('rollbackToNamedCheckpoint → rollback', async () => {
    const spy = new OriginSpyFeature();
    const agent = new TestAgent(spy, new EchoLLM());
    await agent.onCall('first');
    await agent.createNamedCheckpoint('cp-1');
    await agent.onCall('second');
    spy.restoreCalls.length = 0;

    await agent.rollbackToNamedCheckpoint('cp-1');
    expect(spy.lastOrigin).toEqual({ kind: 'rollback' });
  });

  it('rollbackToStepCheckpoint → rollback', async () => {
    const spy = new OriginSpyFeature();
    const agent = new TestAgent(spy, new EchoLLM());
    await agent.onCall('first');
    const context = agent.getContext();
    const features = (agent as unknown as { features: Map<string, AgentFeature> }).features;
    const cp = createStepCheckpoint(context, features);
    spy.state = 42;
    spy.restoreCalls.length = 0;

    await rollbackToStepCheckpoint(cp, context, features);
    expect(spy.lastOrigin).toEqual({ kind: 'rollback' });
    expect(spy.state).toBe(0);
  });

  it('reloadFeature 状态迁移 → hot-reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reload-origin-'));
    const modulePath = join(dir, 'fixture-v2.mjs');
    await writeFile(modulePath, `
export class ReloadOriginFixture {
  constructor() {
    this.name = 'reload-origin-fixture';
    this.state = 0;
    this.lastRestoreCtx = undefined;
  }
  captureState() { return { state: this.state }; }
  restoreState(state, ctx) {
    this.state = state.state;
    this.lastRestoreCtx = ctx;
  }
}
`);
    const spy = new OriginSpyFeature();
    spy.name = 'reload-origin-fixture';
    spy.state = 7;
    const agent = new TestAgent(spy, new EchoLLM());
    await agent.onCall('first');

    const result = await agent.reloadFeature('reload-origin-fixture', pathToFileURL(modulePath).href);
    expect(result.stateTransferred).toBe(true);
    const reloaded = (agent as unknown as { features: Map<string, AgentFeature> }).features.get('reload-origin-fixture') as unknown as { state: number; lastRestoreCtx?: RestoreContext };
    expect(reloaded.state).toBe(7);
    expect(reloaded.lastRestoreCtx?.origin).toEqual({ kind: 'hot-reload' });
  });

  it('restoreFeatureSnapshots 宿主显式 origin（continuity / branch）透传', async () => {
    const spy = new OriginSpyFeature();
    const features = new Map([['origin-spy', spy as AgentFeature]]);

    await restoreFeatureSnapshots(
      [{ featureName: 'origin-spy', snapshot: { state: 3 } }],
      features,
      undefined,
      { kind: 'continuity-import', sourceSessionId: 'src-1' },
    );
    expect(spy.lastOrigin).toEqual({ kind: 'continuity-import', sourceSessionId: 'src-1' });

    await restoreFeatureSnapshots(
      [{ featureName: 'origin-spy', snapshot: { state: 4 } }],
      features,
      undefined,
      { kind: 'branch-import', sourceSessionId: 'src-2' },
    );
    expect(spy.lastOrigin).toEqual({ kind: 'branch-import', sourceSessionId: 'src-2' });
    expect(spy.state).toBe(4);
  });

  it('无 origin 调用（restoreFeatureSnapshots 未传第四参）时 ctx 为 undefined，旧调用方兼容', async () => {
    const spy = new OriginSpyFeature();
    const features = new Map([['origin-spy', spy as AgentFeature]]);
    await restoreFeatureSnapshots([{ featureName: 'origin-spy', snapshot: { state: 9 } }], features);
    expect(spy.state).toBe(9);
    expect(spy.restoreCalls[0].ctx).toBeUndefined();
  });
});

// ========== 旧签名兼容 ==========

describe('旧签名 Feature 兼容', () => {
  it('不接第二参的 restoreState 在恢复入口下行为不变', async () => {
    const legacy = new LegacySignatureFeature();
    const agent = new TestAgent(legacy, new EchoLLM());
    legacy.counter = 3;
    await agent.onCall('first');

    const snapshot = await agent.createSessionSnapshot('legacy-sig');
    legacy.counter = 100;
    await agent.restoreSessionSnapshot(snapshot);
    expect(legacy.counter).toBe(3);
    expect(legacy.restoreCount).toBeGreaterThanOrEqual(1);

    await agent.rollbackToCall(0);
    expect(legacy.restoreCount).toBeGreaterThanOrEqual(2);
  });
});

// ========== 延迟模型绑定 ==========

describe('延迟模型绑定（AgentConfig.llm 可省略）', () => {
  it('未绑定：可构造、可恢复状态，getLLMMeta 返回空 meta 不抛错，onCall 抛错', async () => {
    const spy = new OriginSpyFeature();
    const agent = new TestAgent(spy); // 无 llm
    await agent.preInjectCallStart(); // 不需要模型

    const meta = agent.getLLMMeta();
    expect(meta.modelName).toBeUndefined();
    expect(meta.modelRevision).toBe(0);

    spy.state = 8;
    const snapshot = await agent.createSessionSnapshot('no-llm'); // 快照捕获不需要模型
    await agent.restoreSessionSnapshot(snapshot);
    expect(spy.state).toBe(8);

    await expect(agent.onCall('hello')).rejects.toThrow(/model not bound/);
  });

  it('绑定后执行正常：setModel（resolver）→ onCall 成功', async () => {
    const spy = new OriginSpyFeature();
    const resolver = new MockResolver();
    const agent = new TestAgent(spy, undefined, resolver); // 无 llm，有 resolver

    const ok = agent.setModel('fast-model', { source: 'test' });
    expect(ok).toBe(true);
    expect(agent.getLLMMeta().modelName).toBe('fast-model-model');

    const reply = await agent.onCall('hello');
    expect(reply).toBe('reply:hello');
  });

  it('绑定后执行正常：setLLM 直接注入实例', async () => {
    const spy = new OriginSpyFeature();
    const agent = new TestAgent(spy);
    agent.setLLM(new EchoLLM('direct-model'));
    expect(agent.getLLMMeta().modelName).toBe('direct-model');
    const reply = await agent.onCall('direct');
    expect(reply).toBe('reply:direct');
  });

  it('未注入 resolver 的 setModel 仍显式抛错（装配缺失）', () => {
    const agent = new TestAgent(new OriginSpyFeature());
    expect(() => agent.setModel('any')).toThrow(/no modelResolver/);
  });
});

// ========== modelControl 转发一致性 ==========

describe('FeatureInitContext.modelControl', () => {
  it('onInitiate 收到 modelControl；转发行为与 Agent 直调一致', async () => {
    const spy = new OriginSpyFeature();
    const resolver = new MockResolver();
    const agent = new TestAgent(spy, new EchoLLM('boot-model'), resolver);
    await agent.onCall('first'); // 触发 ensureFeatureTools → onInitiate

    expect(spy.initModelControl).toBeDefined();
    const mc = spy.initModelControl!;

    // hasModelResolver 转发
    expect(mc.hasModelResolver()).toBe(agent.hasModelResolver());
    expect(mc.hasModelResolver()).toBe(true);

    // getLLMMeta 转发（同值）
    expect(mc.getLLMMeta().modelName).toBe(agent.getLLMMeta().modelName);

    // setModel 转发：resolver 收到相同调用，Agent llm 实际切换
    const beforeRevision = agent.getLLMMeta().modelRevision;
    const ok = mc.setModel('other-model', { thinkingEffort: 'high', source: 'model-control-test' });
    expect(ok).toBe(true);
    expect(resolver.calls[resolver.calls.length - 1]).toEqual({
      presetName: 'other-model',
      overrides: { thinkingEffort: 'high' },
    });
    expect(agent.getLLMMeta().modelName).toBe('other-model-model');
    expect(agent.getLLMMeta().modelRevision).toBe(beforeRevision + 1);
    expect(agent.getLLMMeta().source).toBe('model-control-test');

    // setThinkingEffort 转发：按当前 presetName 重 resolve
    const ok2 = mc.setThinkingEffort('low', { source: 'effort-test' });
    expect(ok2).toBe(true);
    expect(resolver.calls[resolver.calls.length - 1]).toEqual({
      presetName: 'other-model',
      overrides: { thinkingEffort: 'low' },
    });

    // 解析失败转发：返回 false，模型不变
    const failed = mc.setModel('missing-preset');
    expect(failed).toBe(false);
    expect(agent.getLLMMeta().modelName).toBe('other-model-model');
  });

  it('未注入 resolver 时 hasModelResolver 为 false（Feature 据此降级，不捕获异常）', async () => {
    const spy = new OriginSpyFeature();
    const agent = new TestAgent(spy, new EchoLLM());
    await agent.onCall('first');
    expect(spy.initModelControl!.hasModelResolver()).toBe(false);
  });
});
