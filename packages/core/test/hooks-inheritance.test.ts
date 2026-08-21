/**
 * 静态钩子声明的继承契约
 *
 * 预制 agent（Claw prebuilt-agents）的标准扩展模式是继承框架 feature 并 override
 * 钩子方法，例如 controlled-todo-feature.js：
 *
 *   TodoFeature (static hooks) ← Inner (override recordToolUsage)
 *     ← declareContinuity 包装类 (class extends Base，不声明 static hooks)
 *
 * 本文件锚定该模式的语义，防止未来重构悄悄破坏：
 * 1. 子类不声明 static hooks → 原型链继承父类声明
 * 2. 子类 override 钩子方法 → 注册条目方法名与 override 一致（声明 key = 方法名，实例分派动态解析）
 * 3. 子类声明自己的 static hooks → 完全 shadow 父类声明（不是增量合并）
 *    —— 这是 JS 类静态属性语义，声明者必须声明全部钩子
 * 4. 双层继承包装（declareContinuity 模式）→ 声明完整保留
 */
import { describe, expect, it } from 'vitest';
import { HooksRegistry } from '../src/core/hooks-registry.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { HookLifecycleSnapshot } from '../src/core/types.js';
import { TodoFeature } from '../src/features/todo/index.js';

/** 把按 lifecycle 分组的 snapshot 扁平化为条目列表 */
function flatEntries(snapshots: HookLifecycleSnapshot[], featureName: string) {
  return snapshots.flatMap((group) =>
    group.entries.filter((e) => e.featureName === featureName),
  );
}

function lifecyclesFor(feature: AgentFeature): string[] {
  const registry = new HooksRegistry();
  registry.collectFromFeature(feature);
  return flatEntries(registry.getSnapshot(), feature.name as string)
    .map((e) => e.lifecycle)
    .sort();
}

describe('static hooks inheritance contract', () => {
  it('subclass without own declaration inherits parent declarations (prototype chain)', () => {
    class Child extends TodoFeature {}
    expect(lifecyclesFor(new Child() as unknown as AgentFeature)).toEqual([
      'CallStart',
      'StepFinish',
      'StepStart',
    ]);
  });

  it('overridden hook method dispatches to subclass implementation', async () => {
    const calls: string[] = [];
    class Child extends TodoFeature {
      protected async recordToolUsage(ctx: any) {
        calls.push('child');
        return super.recordToolUsage(ctx);
      }
    }
    const child = new Child();
    const registry = new HooksRegistry();
    registry.collectFromFeature(child as unknown as AgentFeature);

    const stepFinish = flatEntries(registry.getSnapshot(), 'todo').find(
      (e) => e.lifecycle === 'StepFinish',
    );
    expect(stepFinish?.methodName).toBe('recordToolUsage');
    expect(stepFinish?.kind).toBe('guard');
    expect(stepFinish?.role).toBe('advisor');

    // 声明 key = 方法名，实例分派动态解析：调用条目方法命中子类 override
    await (child as any).recordToolUsage({ llmResponse: { toolCalls: [] } });
    expect(calls).toEqual(['child']);
  });

  it('own static hooks on subclass fully shadows parent declarations (not merged)', () => {
    class Child extends TodoFeature {
      static hooks = {
        onCallStart: { lifecycle: 'CallStart' as const, kind: 'observe' as const },
      };
    }
    // 父类的 StepFinish/StepStart 声明被 shadow，只剩子类自己声明的
    expect(lifecyclesFor(new Child() as unknown as AgentFeature)).toEqual(['CallStart']);
  });

  it('double-layer wrapping (declareContinuity pattern) preserves declarations', () => {
    class Inner extends TodoFeature {
      protected async recordToolUsage(ctx: any) {
        return super.recordToolUsage(ctx);
      }
    }
    // 模拟 declareContinuity：包装类 extends Base，不声明 static hooks
    const Wrapped = class ContinuityAware extends Inner {};
    expect(lifecyclesFor(new Wrapped() as unknown as AgentFeature)).toEqual([
      'CallStart',
      'StepFinish',
      'StepStart',
    ]);
  });
});
