/**
 * 零兼容债契约：钩子唯一入口是静态声明（static hooks）
 *
 * 工作项 A 收口：装饰器路径与 lifecycle 推导回退全部死亡。
 * 老式元数据（constructor._hookDecisions）不再是注册来源；
 * 没有 static hooks 的 Feature 就是没有反向钩子，没有第二条路。
 */

import { describe, it, expect } from 'vitest';
import { CoreLifecycle } from '../src/core/lifecycle.js';
import { HooksRegistry } from '../src/core/hooks-registry.js';
import type { AgentFeature } from '../src/core/feature.js';

function makeLegacyFeature(): AgentFeature {
  class LegacyFeature {
    name = 'legacy-feature';
    onLegacyCallStart(): void {}
  }
  const ctor = LegacyFeature as unknown as {
    new (): LegacyFeature;
    _hookDecisions?: Map<CoreLifecycle, string>;
    _hookSources?: Map<string, unknown>;
  };
  // 复刻老装饰器写入的元数据形态
  ctor._hookDecisions = new Map([[CoreLifecycle.CallStart, 'onLegacyCallStart']]);
  ctor._hookSources = new Map();
  return new LegacyFeature() as unknown as AgentFeature;
}

function makeDeclaredFeature(): AgentFeature {
  class DeclaredFeature {
    name = 'declared-feature';
    static hooks = {
      onCallStart: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
    };
    onCallStart(): void {}
  }
  return new DeclaredFeature() as unknown as AgentFeature;
}

describe('零兼容债：static hooks 是唯一注册入口', () => {
  it('老式装饰器元数据（_hookDecisions）不再注册任何钩子', () => {
    const registry = new HooksRegistry();
    const legacy = makeLegacyFeature();

    registry.collectFromFeature(legacy);

    expect(registry.has(CoreLifecycle.CallStart)).toBe(false);
    expect(registry.get(CoreLifecycle.CallStart)).toEqual([]);
  });

  it('静态声明的 Feature 照常注册', () => {
    const registry = new HooksRegistry();

    registry.collectFromFeature(makeDeclaredFeature());

    expect(registry.has(CoreLifecycle.CallStart)).toBe(true);
    const entries = registry.get(CoreLifecycle.CallStart);
    expect(entries).toHaveLength(1);
    expect(entries[0].methodName).toBe('onCallStart');
    expect(entries[0].kind).toBe('observe');
  });

  it('无声明且无老元数据的 Feature 静默注册零钩子（合法：无钩子 feature）', () => {
    const registry = new HooksRegistry();
    const plain = { name: 'plain-feature' } as AgentFeature;

    registry.collectFromFeature(plain);

    expect(registry.has(CoreLifecycle.CallStart)).toBe(false);
  });
});
