/**
 * Feature 依赖拓扑排序（工作项 A3）测试
 *
 * static inject 声明在装配时解析为初始化顺序：
 * - 依赖（inject）在装配时拓扑排序，缺依赖 = 启动错误带修复建议
 * - 循环依赖 = 启动错误带环路径
 * - 无声明时保持装配顺序（use() 插入序）
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { AgentFeature, FeatureInitContext } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';
import {
  resolveFeatureOrder,
  readInjectDeclarations,
} from '../src/core/feature-graph.js';

class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

function makeFeature(name: string, inject: string[] = [], onInitiated?: (name: string) => void) {
  class F implements AgentFeature {
    name = name;
    static inject = inject;

    async onInitiate(_ctx: FeatureInitContext): Promise<void> {
      onInitiated?.(name);
    }
  }
  return F;
}

// ========== readInjectDeclarations ==========

describe('readInjectDeclarations', () => {
  it('reads static inject array', () => {
    const F = makeFeature('a', ['b', 'c']);
    expect(readInjectDeclarations(new F())).toEqual(['b', 'c']);
  });

  it('returns empty array when no declaration', () => {
    class F implements AgentFeature {
      name = 'f';
    }
    expect(readInjectDeclarations(new F())).toEqual([]);
  });
});

// ========== resolveFeatureOrder（纯函数） ==========

describe('resolveFeatureOrder', () => {
  it('keeps assembly order when no inject declarations', () => {
    const a = new (makeFeature('a'))();
    const b = new (makeFeature('b'))();
    const c = new (makeFeature('c'))();

    const { order, errors } = resolveFeatureOrder([a, b, c]);
    expect(errors).toEqual([]);
    expect(order.map(f => f.name)).toEqual(['a', 'b', 'c']);
  });

  it('initializes dependencies before dependents', () => {
    // a inject b：b 必须先初始化
    const a = new (makeFeature('a', ['b']))();
    const b = new (makeFeature('b'))();

    const { order, errors } = resolveFeatureOrder([a, b]);
    expect(errors).toEqual([]);
    expect(order.map(f => f.name)).toEqual(['b', 'a']);
  });

  it('resolves chained dependencies', () => {
    // c inject b, b inject a → a, b, c
    const a = new (makeFeature('a'))();
    const b = new (makeFeature('b', ['a']))();
    const c = new (makeFeature('c', ['b']))();

    const { order, errors } = resolveFeatureOrder([c, b, a]);
    expect(errors).toEqual([]);
    expect(order.map(f => f.name)).toEqual(['a', 'b', 'c']);
  });

  it('keeps relative order of independent features (stable)', () => {
    const a = new (makeFeature('a'))();
    const b = new (makeFeature('b', ['dep']))();
    const c = new (makeFeature('c'))();
    const dep = new (makeFeature('dep'))();

    const { order, errors } = resolveFeatureOrder([a, b, c, dep]);
    expect(errors).toEqual([]);
    // dep 提前，a/c 相对序保持
    expect(order.map(f => f.name)).toEqual(['a', 'dep', 'b', 'c']);
  });

  it('reports missing_dependency with fix suggestion', () => {
    const a = new (makeFeature('a', ['ghost']))();

    const { order, errors } = resolveFeatureOrder([a]);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('missing_dependency');
    expect(errors[0].message).toContain('a');
    expect(errors[0].message).toContain('ghost');
    expect(errors[0].message).toContain('use(');
  });

  it('reports circular_dependency with cycle path', () => {
    const a = new (makeFeature('a', ['b']))();
    const b = new (makeFeature('b', ['c']))();
    const c = new (makeFeature('c', ['a']))();

    const { errors } = resolveFeatureOrder([a, b, c]);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('circular_dependency');
    // 环路径完整呈现（从任一点起均可，但必须闭合）
    expect(errors[0].message).toMatch(/a → b → c → a|b → c → a → b|c → a → b → c/);
  });

  it('reports self-dependency as circular', () => {
    const a = new (makeFeature('a', ['a']))();

    const { errors } = resolveFeatureOrder([a]);
    expect(errors[0].code).toBe('circular_dependency');
    expect(errors[0].message).toContain('a → a');
  });

  it('reports duplicate_feature_name', () => {
    const a1 = new (makeFeature('dup'))();
    const a2 = new (makeFeature('dup'))();

    const { errors } = resolveFeatureOrder([a1, a2]);
    expect(errors[0].code).toBe('duplicate_feature_name');
  });
});

// ========== Agent 集成：装配时拓扑排序初始化 ==========

describe('Agent assembly order with static inject', () => {
  it('initializes features in topological order', async () => {
    const initiated: string[] = [];
    const tracker = (name: string) => initiated.push(name);

    // 装配顺序故意与依赖顺序相反
    const agent = new Agent({ llm: new ImmediateLLM() })
      .use(new (makeFeature('router', ['storage', 'auth'], tracker))())
      .use(new (makeFeature('auth', ['storage'], tracker))())
      .use(new (makeFeature('storage', [], tracker))());

    await agent.onCall('test');

    expect(initiated).toEqual(['storage', 'auth', 'router']);
  });

  it('throws on missing dependency at first call with fix suggestion', async () => {
    const agent = new Agent({ llm: new ImmediateLLM() })
      .use(new (makeFeature('a', ['ghost']))());

    await expect(agent.onCall('test')).rejects.toThrow(/ghost/);
  });

  it('throws on circular dependency with cycle path', async () => {
    const agent = new Agent({ llm: new ImmediateLLM() })
      .use(new (makeFeature('a', ['b']))())
      .use(new (makeFeature('b', ['a']))());

    await expect(agent.onCall('test')).rejects.toThrow(/a → b → a|b → a → b/);
  });
});
