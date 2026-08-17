/**
 * 静态钩子声明（三原语）测试
 *
 * 工作项 A1：钩子 kind 由作者静态声明（static hooks），替代 lifecycle 硬编码推导。
 * kind 在类定义时即静态可读，是装配预检（工作项 D）与静态分析的前提。
 *
 * 三原语顺序法则（战略文档 §4.A）：
 * - observe：无序，返回值被框架丢弃（消灭 void 钩子意外返回 'approve' 的短路坑）
 * - guard：policy 先于 advisor；首个 Approve/Deny 短路
 * - transform：链式变换（由 executeTransform 调度）
 */

import { describe, it, expect } from 'vitest';
import { CoreLifecycle, Decision } from '../core/lifecycle.js';
import {
  readHookDeclarations,
  validateHookDeclarations,
  validatePolicyUniqueness,
  type HookDeclaration,
  type HookDeclarations,
} from '../core/hook-declarations.js';
import { HooksRegistry } from '../core/hooks-registry.js';
import type { AgentFeature } from '../core/feature.js';
import type {
  StepStartContext,
  ToolContext,
  StepFinishDecisionContext,
  ToolResultTransformContext,
} from '../core/lifecycle.js';
import type { ToolExecResult } from '../core/context.js';

// ========== 测试辅助 ==========

/** 声明静态钩子的辅助：把声明挂到类的 constructor.hooks 上 */
function withDeclarations<T extends new (...args: any[]) => InstanceType<T>>(
  ctor: T,
  declarations: HookDeclarations,
): T {
  (ctor as any).hooks = declarations;
  return ctor;
}

/** 最小合法 observe 声明 feature */
function makeObserveFeature() {
  class F implements AgentFeature {
    name = 'obs-feature';
    onStepStart(_ctx: StepStartContext): void {}
  }
  return withDeclarations(F, {
    onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
  });
}

// ========== readHookDeclarations ==========

describe('readHookDeclarations', () => {
  it('reads static hooks from constructor and fills default guard role', () => {
    class F implements AgentFeature {
      name = 'f';
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
      afterTool(_ctx: ToolContext) {
        return Decision.Approve;
      }
    }
    withDeclarations(F, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard' },
      afterTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    const decls = readHookDeclarations(new F());
    expect(Object.keys(decls).sort()).toEqual(['afterTool', 'beforeTool']);
    // guard 未声明 role 时默认 advisor
    expect(decls.beforeTool).toEqual({
      lifecycle: CoreLifecycle.ToolUse,
      kind: 'guard',
      role: 'advisor',
    });
    // 显式 policy 原样保留
    expect(decls.afterTool?.role).toBe('policy');
  });

  it('returns empty object when no static declaration exists', () => {
    class F implements AgentFeature {
      name = 'f';
    }
    expect(readHookDeclarations(new F())).toEqual({});
  });
});

// ========== validateHookDeclarations ==========

describe('validateHookDeclarations', () => {
  it('passes for valid observe/guard/transform declarations', () => {
    class F implements AgentFeature {
      name = 'ok-feature';
      onStepStart(_ctx: StepStartContext): void {}
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
      transformResult(_ctx: ToolResultTransformContext): ToolExecResult | undefined {
        return undefined;
      }
    }
    withDeclarations(F, {
      onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'advisor' },
      transformResult: { lifecycle: CoreLifecycle.ToolResultTransform, kind: 'transform' },
    });

    expect(validateHookDeclarations(new F())).toEqual([]);
  });

  it('reports method_missing with fix suggestion', () => {
    class F implements AgentFeature {
      name = 'f';
    }
    withDeclarations(F, {
      onGhost: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
    });

    const issues = validateHookDeclarations(new F());
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('method_missing');
    expect(issues[0].feature).toBe('f');
    expect(issues[0].method).toBe('onGhost');
    expect(issues[0].message).toContain('onGhost');
  });

  it('reports method_not_function when declared member is not a function', () => {
    class F implements AgentFeature {
      name = 'f';
      onStepStart = 'not-a-function';
    }
    withDeclarations(F, {
      onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
    });

    const issues = validateHookDeclarations(new F());
    expect(issues[0].code).toBe('method_not_function');
  });

  it('reports invalid_kind', () => {
    class F implements AgentFeature {
      name = 'f';
      hook() {}
    }
    withDeclarations(F, {
      hook: { lifecycle: CoreLifecycle.StepStart, kind: 'notify' as any },
    });

    const issues = validateHookDeclarations(new F());
    expect(issues[0].code).toBe('invalid_kind');
    expect(issues[0].message).toContain('observe');
    expect(issues[0].message).toContain('guard');
    expect(issues[0].message).toContain('transform');
  });

  it('reports invalid_lifecycle', () => {
    class F implements AgentFeature {
      name = 'f';
      hook() {}
    }
    withDeclarations(F, {
      hook: { lifecycle: 'NotALifecycle' as any, kind: 'observe' },
    });

    const issues = validateHookDeclarations(new F());
    expect(issues[0].code).toBe('invalid_lifecycle');
  });

  it('reports invalid_kind_lifecycle: guard only on ToolUse/StepFinish', () => {
    class F implements AgentFeature {
      name = 'f';
      onCallStart() {}
      onToolFinished() {}
    }
    withDeclarations(F, {
      onCallStart: { lifecycle: CoreLifecycle.CallStart, kind: 'guard' },
      onToolFinished: { lifecycle: CoreLifecycle.ToolFinished, kind: 'guard' },
    });

    const issues = validateHookDeclarations(new F());
    expect(issues).toHaveLength(2);
    expect(issues.every(i => i.code === 'invalid_kind_lifecycle')).toBe(true);
  });

  it('reports invalid_kind_lifecycle: transform only on ToolResultTransform', () => {
    class F implements AgentFeature {
      name = 'f';
      rewrite() {}
    }
    withDeclarations(F, {
      rewrite: { lifecycle: CoreLifecycle.ToolUse, kind: 'transform' },
    });

    const issues = validateHookDeclarations(new F());
    expect(issues[0].code).toBe('invalid_kind_lifecycle');
  });

  it('reports role_on_non_guard', () => {
    class F implements AgentFeature {
      name = 'f';
      onStepStart(): void {}
    }
    withDeclarations(F, {
      onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe', role: 'policy' as any },
    });

    const issues = validateHookDeclarations(new F());
    expect(issues[0].code).toBe('role_on_non_guard');
  });
});

// ========== validatePolicyUniqueness（装配级校验） ==========

describe('validatePolicyUniqueness', () => {
  it('reports duplicate_policy naming both features with fix suggestion', () => {
    class F1 implements AgentFeature {
      name = 'alpha';
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
    }
    withDeclarations(F1, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    class F2 implements AgentFeature {
      name = 'beta';
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
    }
    withDeclarations(F2, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    const issues = validatePolicyUniqueness([new F1(), new F2()]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('duplicate_policy');
    expect(issues[0].message).toContain('alpha');
    expect(issues[0].message).toContain('beta');
    expect(issues[0].message).toContain('advisor');
  });

  it('passes with one policy and multiple advisors', () => {
    class F1 implements AgentFeature {
      name = 'alpha';
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
    }
    withDeclarations(F1, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    class F2 implements AgentFeature {
      name = 'beta';
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
    }
    withDeclarations(F2, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'advisor' },
    });

    expect(validatePolicyUniqueness([new F1(), new F2()])).toEqual([]);
  });
});

// ========== HooksRegistry 集成：声明优先 + 三原语执行语义 ==========

describe('HooksRegistry with static declarations', () => {
  it('registers declared hooks with kind/role and prefers declaration over decorator', () => {
    const registry = new HooksRegistry();
    class F implements AgentFeature {
      name = 'f';
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
    }
    withDeclarations(F, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    registry.collectFromFeature(new F());
    const hooks = registry.get(CoreLifecycle.ToolUse);
    expect(hooks).toHaveLength(1);
    expect((hooks[0] as any).kind).toBe('guard');
    expect((hooks[0] as any).role).toBe('policy');

    const snapshot = registry.getSnapshot();
    const toolUse = snapshot.find(s => s.lifecycle === CoreLifecycle.ToolUse);
    expect(toolUse?.kind).toBe('guard');
    expect(toolUse?.entries[0].role).toBe('policy');
  });

  it('throws with fix suggestion when declaration is invalid', () => {
    const registry = new HooksRegistry();
    class F implements AgentFeature {
      name = 'broken';
      hook() {}
    }
    withDeclarations(F, {
      hook: { lifecycle: CoreLifecycle.CallStart, kind: 'guard' },
    });

    expect(() => registry.collectFromFeature(new F())).toThrow(/broken/);
    expect(() => registry.collectFromFeature(new F())).toThrow(/guard/);
  });

  it('observe hooks never short-circuit even if they return approve-like values', async () => {
    const registry = new HooksRegistry();
    const executed: string[] = [];

    class Bad implements AgentFeature {
      name = 'bad';
      onStepStart(): string {
        executed.push('bad');
        // 已知坑：void 钩子意外返回 'approve' 字符串
        return 'approve' as any;
      }
    }
    withDeclarations(Bad, {
      onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
    });

    class Good implements AgentFeature {
      name = 'good';
      onStepStart(): void {
        executed.push('good');
      }
    }
    withDeclarations(Good, {
      onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
    });

    registry.collectFromFeature(new Bad());
    registry.collectFromFeature(new Good());

    await registry.executeVoid(CoreLifecycle.StepStart, {
      step: 0,
      callIndex: 0,
      input: 'test',
      context: {} as any,
    });

    // 关键断言：observe 返回值被丢弃，后续观察者照常执行
    expect(executed).toEqual(['bad', 'good']);
  });

  it('guard: policy runs before advisor regardless of registration order', async () => {
    const registry = new HooksRegistry();
    const order: string[] = [];

    class AdvisorFirst implements AgentFeature {
      name = 'advisor-first';
      beforeTool(_ctx: ToolContext) {
        order.push('advisor');
        return Decision.Continue;
      }
    }
    withDeclarations(AdvisorFirst, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'advisor' },
    });

    class PolicySecond implements AgentFeature {
      name = 'policy-second';
      beforeTool(_ctx: ToolContext) {
        order.push('policy');
        return Decision.Continue;
      }
    }
    withDeclarations(PolicySecond, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    // advisor 先注册，policy 后注册——执行时 policy 仍先行
    registry.collectFromFeature(new AdvisorFirst());
    registry.collectFromFeature(new PolicySecond());

    await registry.executeDecision(CoreLifecycle.ToolUse, {
      call: {} as any,
      tool: {} as any,
      step: 0,
      input: '',
      context: {} as any,
      getFeature: () => undefined,
    });

    expect(order).toEqual(['policy', 'advisor']);
  });

  it('guard: first Approve short-circuits remaining guards', async () => {
    const registry = new HooksRegistry();
    const order: string[] = [];

    class Policy implements AgentFeature {
      name = 'p';
      beforeTool(_ctx: ToolContext) {
        order.push('policy');
        return { action: Decision.Approve, reason: 'trusted' };
      }
    }
    withDeclarations(Policy, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    class Advisor implements AgentFeature {
      name = 'a';
      beforeTool(_ctx: ToolContext) {
        order.push('advisor');
        return Decision.Continue;
      }
    }
    withDeclarations(Advisor, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'advisor' },
    });

    registry.collectFromFeature(new Advisor());
    registry.collectFromFeature(new Policy());

    const decision = await registry.executeDecision(CoreLifecycle.ToolUse, {
      call: {} as any,
      tool: {} as any,
      step: 0,
      input: '',
      context: {} as any,
      getFeature: () => undefined,
    });

    expect(decision).toEqual({ action: Decision.Approve, reason: 'trusted' });
    expect(order).toEqual(['policy']);
  });

  // 零兼容债契约：legacy 装饰器元数据不再注册任何钩子，
  // 由 hooks-static-only.test.ts 覆盖（static hooks 是唯一入口）。

  it('collect throws on second policy at runtime (mountFeature defense)', () => {
    const registry = new HooksRegistry();

    class P1 implements AgentFeature {
      name = 'p1';
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
    }
    withDeclarations(P1, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    class P2 implements AgentFeature {
      name = 'p2';
      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
    }
    withDeclarations(P2, {
      beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    });

    registry.collectFromFeature(new P1());
    expect(() => registry.collectFromFeature(new P2())).toThrow(/policy/);
  });
});
