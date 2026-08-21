/**
 * 测试静态声明的多钩子约束
 *
 * 验证（static hooks 唯一入口后）：
 * 1. 同一 Feature 内多个 observe 钩子按声明序注册与执行
 * 2. 同一 Feature 内多个 guard（policy/advisor）按原语法则排序执行
 * 3. 装饰器时代的"decision 钩子单例约束"由声明模型取代：
 *    裁决权唯一性由跨 feature 的 policy 唯一性校验保证
 *    （见 hook-declarations.test.ts 的 duplicate_policy 用例）
 */

import { describe, it, expect } from 'vitest';
import { HooksRegistry } from '../src/core/hooks-registry.js';
import { CoreLifecycle, Decision } from '../src/core/lifecycle.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { HookDeclarations } from '../src/core/hook-declarations.js';
import type {
  StepFinishDecisionContext,
  StepStartContext,
  ToolContext,
} from '../src/core/lifecycle.js';

function withDeclarations<T extends new (...args: any[]) => InstanceType<T>>(
  ctor: T,
  declarations: HookDeclarations,
): T {
  (ctor as any).hooks = declarations;
  return ctor;
}

describe('静态声明多钩子约束', () => {
  it('同一 Feature 内多个 observe 钩子按声明序注册并执行', async () => {
    const registry = new HooksRegistry();
    const executionOrder: string[] = [];

    class MultiObserveFeature implements AgentFeature {
      name = 'MultiObserveFeature';

      async firstHook(_ctx: StepStartContext) { executionOrder.push('first'); }
      async secondHook(_ctx: StepStartContext) { executionOrder.push('second'); }
      async thirdHook(_ctx: StepStartContext) { executionOrder.push('third'); }
    }
    withDeclarations(MultiObserveFeature, {
      firstHook: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
      secondHook: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
      thirdHook: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
    });

    registry.collectFromFeature(new MultiObserveFeature());

    const hooks = registry.get(CoreLifecycle.StepStart);
    expect(hooks).toHaveLength(3);
    expect(hooks.map(h => h.methodName)).toEqual(['firstHook', 'secondHook', 'thirdHook']);

    await registry.executeVoid(CoreLifecycle.StepStart, {
      step: 0, callIndex: 0, input: 'test', context: {} as any,
    });

    expect(executionOrder).toEqual(['first', 'second', 'third']);
  });

  it('同一 Feature 内 policy 先于 advisor 执行（跨钩子原语法则）', async () => {
    const registry = new HooksRegistry();
    const executionOrder: string[] = [];

    // advisor 声明在前，policy 声明在后——执行仍应 policy 先行
    class MixedGuardFeature implements AgentFeature {
      name = 'MixedGuardFeature';

      async advisorCheck(_ctx: ToolContext) { executionOrder.push('advisor'); return Decision.Continue; }
      async policyCheck(_ctx: ToolContext) { executionOrder.push('policy'); return Decision.Continue; }
    }
    withDeclarations(MixedGuardFeature, {
      advisorCheck: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'advisor' },
      policyCheck: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    registry.collectFromFeature(new MixedGuardFeature());

    await registry.executeDecision(CoreLifecycle.ToolUse, {
      call: {} as any, tool: {} as any, step: 0, input: '', context: {} as any,
      getFeature: () => undefined,
    });

    expect(executionOrder).toEqual(['policy', 'advisor']);
  });

  it('guard 与 observe 混挂同一 lifecycle：guard 先裁决，observe 收尾', async () => {
    const registry = new HooksRegistry();
    const executionOrder: string[] = [];

    class MixedKindFeature implements AgentFeature {
      name = 'MixedKindFeature';

      async observeUse(_ctx: ToolContext) { executionOrder.push('observe'); }
      async guardUse(_ctx: ToolContext) { executionOrder.push('guard'); return Decision.Continue; }
    }
    withDeclarations(MixedKindFeature, {
      observeUse: { lifecycle: CoreLifecycle.ToolUse, kind: 'observe' },
      guardUse: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'advisor' },
    });

    registry.collectFromFeature(new MixedKindFeature());

    const result = await registry.executeDecision(CoreLifecycle.ToolUse, {
      call: {} as any, tool: {} as any, step: 0, input: '', context: {} as any,
      getFeature: () => undefined,
    });

    expect(result).toBe(Decision.Continue);
    expect(executionOrder).toEqual(['guard', 'observe']);
  });

  it('StepFinish guard 返回 Deny 终止循环', async () => {
    const registry = new HooksRegistry();
    const observed: string[] = [];

    class StopFeature implements AgentFeature {
      name = 'StopFeature';

      async observeStep(_ctx: StepFinishDecisionContext) { observed.push('observe'); }
      async stopLoop(_ctx: StepFinishDecisionContext) { return Decision.Deny; }
    }
    withDeclarations(StopFeature, {
      observeStep: { lifecycle: CoreLifecycle.StepFinish, kind: 'observe' },
      stopLoop: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard', role: 'policy' },
    });

    registry.collectFromFeature(new StopFeature());

    const decision = await registry.executeDecision(CoreLifecycle.StepFinish, {
      step: 0, input: '', context: {} as any, getFeature: () => undefined,
    } as any);

    expect(decision).toEqual({ action: Decision.Deny });
    // policy 先执行并 Deny → 短路整批，同批 observe 不再执行
    expect(observed).toEqual([]);
  });
});
