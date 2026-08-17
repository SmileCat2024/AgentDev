import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { Agent } from '../core/agent.js';
import { resolveFeatureExport } from '../core/feature-reload.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

// ========== 测试用最小 Agent ==========

class EchoLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    return { content: `reply:${lastUser}` };
  }
}

/**
 * 初始挂载的 v1 fixture（与磁盘 fixture 同名，可被模块版本替换）。
 */
class HotReloadFixtureV1 implements AgentFeature {
  readonly name = 'hot-reload-fixture';
  counter = 0;

  getTools(): Tool[] {
    return [
      {
        name: 'hot_tool',
        description: 'fixture v1',
        execute: async () => `v1:${this.counter}`,
      },
    ];
  }

  captureState(): unknown {
    return { counter: this.counter };
  }

  restoreState(snapshot: unknown): void {
    this.counter = (snapshot as { counter: number }).counter;
  }
}

class ReloadTestAgent extends Agent {
  constructor(feature?: AgentFeature) {
    super({
      llm: new EchoLLM(),
      maxTurns: 1,
      name: 'ReloadTestAgent',
      systemMessage: 'reload test',
    });
    this.use(feature ?? new HotReloadFixtureV1());
  }

  getFeatureInstance(name: string): AgentFeature | undefined {
    return (this as unknown as { features: Map<string, AgentFeature> }).features.get(name);
  }
}

// ========== Fixture 模块内容 ==========

const V2_MODULE = `
export class HotReloadFixture {
  constructor() {
    this.name = 'hot-reload-fixture';
    this.counter = 0;
  }
  getTools() {
    return [{
      name: 'hot_tool',
      description: 'fixture v2',
      execute: async () => 'v2:' + this.counter,
    }];
  }
  captureState() { return { counter: this.counter }; }
  restoreState(state) { this.counter = state.counter; }
  increment() { this.counter += 1; }
}
`;

const V3_MODULE = `
export class HotReloadFixture {
  constructor() {
    this.name = 'hot-reload-fixture';
    this.counter = 0;
  }
  getTools() {
    throw new Error('v3 broken on purpose');
  }
  captureState() { return { counter: this.counter }; }
  restoreState(state) { this.counter = state.counter; }
}
`;

const WRONG_EXPORT_MODULE = `
export class SomethingElse {
  constructor() { this.name = 'something-else'; }
  getTools() { return []; }
}
`;

const NO_STATE_MODULE = `
export class HotReloadFixture {
  constructor() {
    this.name = 'hot-reload-fixture';
    this.counter = 0;
  }
  getTools() {
    return [{
      name: 'hot_tool',
      description: 'fixture no-state',
      execute: async () => 'nostate:' + this.counter,
    }];
  }
  increment() { this.counter += 1; }
}
`;

// ========== 测试 ==========

describe('feature reload (B 热载通道)', () => {
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'agentdev-reload-'));
    await writeFile(join(fixtureDir, 'fixture-v2.mjs'), V2_MODULE, 'utf-8');
    await writeFile(join(fixtureDir, 'fixture-broken.mjs'), V3_MODULE, 'utf-8');
    await writeFile(join(fixtureDir, 'fixture-wrong.mjs'), WRONG_EXPORT_MODULE, 'utf-8');
    await writeFile(join(fixtureDir, 'fixture-nostate.mjs'), NO_STATE_MODULE, 'utf-8');
  });

  describe('resolveFeatureExport（纯函数）', () => {
    it('按类名匹配导出', () => {
      const mod = { HotReloadFixture: class HotReloadFixture {}, Other: class Other {} };
      const Ctor = resolveFeatureExport(mod, 'HotReloadFixture');
      expect(Ctor.name).toBe('HotReloadFixture');
    });

    it('类名不匹配时回退唯一 class 导出', () => {
      const mod = { RenamedFixture: class RenamedFixture {} };
      const Ctor = resolveFeatureExport(mod, 'HotReloadFixture');
      expect(Ctor.name).toBe('RenamedFixture');
    });

    it('多个 class 且无匹配时报错并列出可用导出名', () => {
      const mod = { A: class A {}, B: class B {} };
      expect(() => resolveFeatureExport(mod, 'HotReloadFixture')).toThrow(
        /available exports: A, B/,
      );
    });

    it('无 class 导出但 default 是 class 时回退 default', () => {
      const mod = { helper: () => {}, default: class FromDefault {} };
      const Ctor = resolveFeatureExport(mod, 'HotReloadFixture');
      expect(Ctor.name).toBe('FromDefault');
    });
  });

  describe('reloadFeature happy path', () => {
    it('替换实现并迁移状态：新实例 + counter 保留 + 新工具行为', async () => {
      const agent = new ReloadTestAgent();
      const old = agent.getFeatureInstance('hot-reload-fixture') as HotReloadFixtureV1;
      old.counter = 5;
      await agent.onCall('hello'); // 初始化 feature tools

      const result = await agent.reloadFeature(
        'hot-reload-fixture',
        join(fixtureDir, 'fixture-v2.mjs'),
      );

      expect(result.featureName).toBe('hot-reload-fixture');
      expect(result.stateTransferred).toBe(true);
      expect(result.rolledBack).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const next = agent.getFeatureInstance('hot-reload-fixture');
      expect(next).toBeDefined();
      expect(next).not.toBe(old); // 实例已替换
      expect((next as unknown as { counter: number }).counter).toBe(5); // 状态迁移

      // 新代码生效：工具行为来自 v2 模块
      const tools = agent.getTools().getAll();
      const hotTool = tools.find(t => t.name === 'hot_tool');
      expect(hotTool?.description).toBe('fixture v2');
      await expect(hotTool!.execute!({} as never)).resolves.toBe('v2:5');
    });

    it('同一路径重写后再次 reload 拿到新代码（cache-busting）', async () => {
      const mutatePath = join(fixtureDir, 'fixture-mutate.mjs');
      await writeFile(mutatePath, V2_MODULE, 'utf-8');

      const agent = new ReloadTestAgent();
      (agent.getFeatureInstance('hot-reload-fixture') as HotReloadFixtureV1).counter = 1;
      await agent.onCall('hello');

      await agent.reloadFeature('hot-reload-fixture', mutatePath);
      let tool = agent.getTools().getAll().find(t => t.name === 'hot_tool');
      expect(tool?.description).toBe('fixture v2');

      // 原地重写为 no-state 版本（同名文件，内容不同）
      await writeFile(mutatePath, NO_STATE_MODULE, 'utf-8');
      const result = await agent.reloadFeature('hot-reload-fixture', mutatePath);

      // 若无 cache-busting，此处仍是 v2
      tool = agent.getTools().getAll().find(t => t.name === 'hot_tool');
      expect(tool?.description).toBe('fixture no-state');
      expect(result.stateTransferred).toBe(false); // 新版本无状态契约
    });

    it('reload 不触碰会话上下文', async () => {
      const agent = new ReloadTestAgent();
      await agent.onCall('first');
      const before = agent.getContext().getAll();

      await agent.reloadFeature('hot-reload-fixture', join(fixtureDir, 'fixture-v2.mjs'));

      const after = agent.getContext().getAll();
      expect(after).toEqual(before);
    });
  });

  describe('失败自动回退', () => {
    it('新模块 mount 失败时回退旧实例：工具与状态完整恢复', async () => {
      const agent = new ReloadTestAgent();
      const old = agent.getFeatureInstance('hot-reload-fixture') as HotReloadFixtureV1;
      old.counter = 7;
      await agent.onCall('hello');

      await expect(
        agent.reloadFeature('hot-reload-fixture', join(fixtureDir, 'fixture-broken.mjs')),
      ).rejects.toThrow(/mount/);

      // 旧实例回归：同一对象、状态保留、v1 工具可用
      const current = agent.getFeatureInstance('hot-reload-fixture');
      expect(current).toBe(old);
      expect((current as HotReloadFixtureV1).counter).toBe(7);
      const tool = agent.getTools().getAll().find(t => t.name === 'hot_tool');
      expect(tool?.description).toBe('fixture v1');
      await expect(tool!.execute!({} as never)).resolves.toBe('v1:7');
    });

    it('新 feature name 不匹配时在实例化阶段回退并报错', async () => {
      const agent = new ReloadTestAgent();
      const old = agent.getFeatureInstance('hot-reload-fixture');
      await agent.onCall('hello');

      // 模块导出唯一 class 但 name 属性不匹配 → instantiate 阶段身份校验失败
      await expect(
        agent.reloadFeature('hot-reload-fixture', join(fixtureDir, 'fixture-wrong.mjs')),
      ).rejects.toThrow(/instantiate.*something-else|something-else.*instantiate/s);

      expect(agent.getFeatureInstance('hot-reload-fixture')).toBe(old);
      expect(agent.getTools().getAll().find(t => t.name === 'hot_tool')).toBeDefined();
    });
  });

  describe('no-state feature 热载', () => {
    it('显式 stateTransferred=false，热载仍成功', async () => {
      const agent = new ReloadTestAgent();
      await agent.onCall('hello');

      const result = await agent.reloadFeature(
        'hot-reload-fixture',
        join(fixtureDir, 'fixture-nostate.mjs'),
      );

      expect(result.stateTransferred).toBe(false);
      const tool = agent.getTools().getAll().find(t => t.name === 'hot_tool');
      expect(tool?.description).toBe('fixture no-state');
    });
  });

  describe('错误输入', () => {
    it('未知 feature 名直接报错', async () => {
      const agent = new ReloadTestAgent();
      await expect(
        agent.reloadFeature('no-such-feature', join(fixtureDir, 'fixture-v2.mjs')),
      ).rejects.toThrow(/no-such-feature/);
    });

    it('缺 modulePath 且无静态 reloadPath 声明时报错并给出指引', async () => {
      const agent = new ReloadTestAgent();
      await agent.onCall('hello');
      await expect(agent.reloadFeature('hot-reload-fixture')).rejects.toThrow(
        /modulePath/,
      );
    });

    it('静态 reloadPath 声明可作为缺省来源', async () => {
      const agent = new ReloadTestAgent();
      await agent.onCall('hello');

      // 在旧实例构造器上声明 reloadPath
      const old = agent.getFeatureInstance('hot-reload-fixture') as HotReloadFixtureV1;
      (old.constructor as unknown as { reloadPath: string }).reloadPath = pathToFileURL(
        join(fixtureDir, 'fixture-v2.mjs'),
      ).href;

      const result = await agent.reloadFeature('hot-reload-fixture');
      expect(result.rolledBack).toBe(false);
      expect(
        agent.getTools().getAll().find(t => t.name === 'hot_tool')?.description,
      ).toBe('fixture v2');
    });
  });
});
