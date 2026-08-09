/**
 * 测试 HooksRegistry 的 disable/enable 功能
 *
 * 覆盖：
 * 1. 基础 disable/enable 操作
 * 2. 各 hook kind 被 disable 后的行为
 * 3. mid-dispatch 快照语义（竞态安全）
 * 4. getSnapshot 包含 enabled 字段
 * 5. 生命周期（collectFromFeature 默认启用）
 */

import { describe, it, expect } from 'vitest';
import { StepStart, ToolUse, StepFinish, Decision } from '../core/hooks-decorator.js';
import { HooksRegistry } from '../core/hooks-registry.js';
import { CoreLifecycle } from '../core/lifecycle.js';
import type { AgentFeature } from '../core/feature.js';
import type {
  StepStartContext,
  ToolContext,
  StepFinishDecisionContext,
} from '../core/lifecycle.js';

function applyMethodDecorator(
  decorator: (target: any, propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor,
  target: any,
  propertyKey: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
  expect(descriptor).toBeDefined();
  Object.defineProperty(target, propertyKey, decorator(target, propertyKey, descriptor!));
}

// ========== 辅助：创建带装饰器的 Feature ==========

function makeNotifyFeature(name: string, methodName: string, sideEffect: () => void) {
  class TestFeature implements AgentFeature {
    name = name;
    async [methodName](_ctx: StepStartContext) {
      sideEffect();
    }
  }
  applyMethodDecorator(StepStart, TestFeature.prototype, methodName as any);
  return new TestFeature();
}

function makeDecisionFeature(name: string, methodName: string, returnValue: any) {
  class TestFeature implements AgentFeature {
    name = name;
    async [methodName](_ctx: ToolContext) {
      return returnValue;
    }
  }
  applyMethodDecorator(ToolUse, TestFeature.prototype, methodName as any);
  return new TestFeature();
}

describe('HooksRegistry disable/enable', () => {
  describe('基础功能', () => {
    it('disable 后 execute 跳过该钩子，副作用不发生', async () => {
      const registry = new HooksRegistry();
      let called = false;
      const feature = makeNotifyFeature('TestFeature', 'onStepStart', () => { called = true; });
      registry.collectFromFeature(feature);

      registry.disableHook(CoreLifecycle.StepStart, 'TestFeature', 'onStepStart');

      await registry.executeVoid(CoreLifecycle.StepStart, {
        step: 0, callIndex: 0, input: '', context: {} as any,
      });

      expect(called).toBe(false);
    });

    it('disable decision 钩子后等价于返回 Continue', async () => {
      const registry = new HooksRegistry();
      // 一个返回 Deny 的 decision 钩子
      const feature = makeDecisionFeature('BlockFeature', 'onToolUse', Decision.Deny);
      registry.collectFromFeature(feature);

      registry.disableHook(CoreLifecycle.ToolUse, 'BlockFeature', 'onToolUse');

      const result = await registry.executeDecision(CoreLifecycle.ToolUse, {
        call: {} as any, tool: {} as any, step: 0, input: '', context: {} as any,
        getFeature: () => undefined,
      });

      // disabled → 等价于 Continue（不是 Deny）
      expect(result).toBe(Decision.Continue);
    });

    it('enable 恢复后钩子正常执行', async () => {
      const registry = new HooksRegistry();
      let called = false;
      const feature = makeNotifyFeature('TestFeature', 'onStepStart', () => { called = true; });
      registry.collectFromFeature(feature);

      registry.disableHook(CoreLifecycle.StepStart, 'TestFeature', 'onStepStart');
      registry.enableHook(CoreLifecycle.StepStart, 'TestFeature', 'onStepStart');

      await registry.executeVoid(CoreLifecycle.StepStart, {
        step: 0, callIndex: 0, input: '', context: {} as any,
      });

      expect(called).toBe(true);
    });

    it('禁用不影响同 lifecycle 其他钩子的执行', async () => {
      const registry = new HooksRegistry();
      const calls: string[] = [];

      const featA = makeNotifyFeature('FeatA', 'hook', () => calls.push('A'));
      const featB = makeNotifyFeature('FeatB', 'hook', () => calls.push('B'));
      const featC = makeNotifyFeature('FeatC', 'hook', () => calls.push('C'));
      registry.collectFromFeature(featA);
      registry.collectFromFeature(featB);
      registry.collectFromFeature(featC);

      registry.disableHook(CoreLifecycle.StepStart, 'FeatB', 'hook');

      await registry.executeVoid(CoreLifecycle.StepStart, {
        step: 0, callIndex: 0, input: '', context: {} as any,
      });

      expect(calls).toEqual(['A', 'C']);
    });

    it('disable 不存在的钩子返回 false', () => {
      const registry = new HooksRegistry();
      expect(registry.disableHook(CoreLifecycle.StepStart, 'NonExistent', 'method')).toBe(false);
    });

    it('重复 disable 同一钩子返回 false', () => {
      const registry = new HooksRegistry();
      const feature = makeNotifyFeature('F', 'hook', () => {});
      registry.collectFromFeature(feature);

      expect(registry.disableHook(CoreLifecycle.StepStart, 'F', 'hook')).toBe(true);
      expect(registry.disableHook(CoreLifecycle.StepStart, 'F', 'hook')).toBe(false);
    });

    it('重复 enable 已启用钩子返回 false', () => {
      const registry = new HooksRegistry();
      const feature = makeNotifyFeature('F', 'hook', () => {});
      registry.collectFromFeature(feature);

      // 默认已启用，直接 enable 返回 false
      expect(registry.enableHook(CoreLifecycle.StepStart, 'F', 'hook')).toBe(false);
    });
  });

  describe('mid-dispatch 快照语义', () => {
    it('execute 入口快照后，dispatch 期间禁用后续钩子不影响本次执行', async () => {
      const registry = new HooksRegistry();

      class MidDispatchFeature implements AgentFeature {
        name = 'MidDispatch';

        // 第一个钩子：在执行期间禁用第二个钩子
        async first(_ctx: StepStartContext) {
          // 在 first 的 await 期间，禁用 second
          // 由于 Node.js 单线程，这段同步代码会在 second 之前执行
          registry.disableHook(CoreLifecycle.StepStart, 'MidDispatch', 'second');
        }

        async second(_ctx: StepStartContext) {}
      }

      applyMethodDecorator(StepStart, MidDispatchFeature.prototype, 'first' as any);
      applyMethodDecorator(StepStart, MidDispatchFeature.prototype, 'second' as any);

      const feature = new MidDispatchFeature();
      // 用 spy 追踪 second 是否被调用
      let secondCalled = false;
      const origSecond = feature.second.bind(feature);
      (feature as any).second = (_ctx: StepStartContext) => {
        secondCalled = true;
        return origSecond(_ctx);
      };

      registry.collectFromFeature(feature);

      await registry.executeVoid(CoreLifecycle.StepStart, {
        step: 0, callIndex: 0, input: '', context: {} as any,
      });

      // second 仍然被执行（入口快照包含它）
      expect(secondCalled).toBe(true);
    });

    it('dispatch 结束后的下一次 execute 生效新的 enabled 状态', async () => {
      const registry = new HooksRegistry();
      const calls: string[] = [];

      class TwoHookFeature implements AgentFeature {
        name = 'TwoHook';
        async first(_ctx: StepStartContext) { calls.push('first'); }
        async second(_ctx: StepStartContext) { calls.push('second'); }
      }

      applyMethodDecorator(StepStart, TwoHookFeature.prototype, 'first' as any);
      applyMethodDecorator(StepStart, TwoHookFeature.prototype, 'second' as any);

      registry.collectFromFeature(new TwoHookFeature());

      // 第一次 execute：两个都执行
      await registry.executeVoid(CoreLifecycle.StepStart, {
        step: 0, callIndex: 0, input: '', context: {} as any,
      });
      expect(calls).toEqual(['first', 'second']);

      // 禁用 second
      registry.disableHook(CoreLifecycle.StepStart, 'TwoHook', 'second');

      // 第二次 execute：second 被跳过
      calls.length = 0;
      await registry.executeVoid(CoreLifecycle.StepStart, {
        step: 0, callIndex: 0, input: '', context: {} as any,
      });
      expect(calls).toEqual(['first']);
    });

    it('executeTransform 入口快照同理', async () => {
      const registry = new HooksRegistry();
      const transformedBy: string[] = [];

      class TransformFeature implements AgentFeature {
        name = 'TransformFeat';
        async transformA(_ctx: any) {
          transformedBy.push('A');
          return undefined; // 不修改
        }
        async transformB(_ctx: any) {
          transformedBy.push('B');
          return undefined;
        }
      }

      // ToolResultTransform 是非 decision 钩子，允许多个
      // 手动注册元数据
      const proto = TransformFeature.prototype;
      const constructor = proto.constructor as any;
      if (!constructor._hookDecisions) {
        constructor._hookDecisions = new Map();
      }
      constructor._hookDecisions.set(CoreLifecycle.ToolResultTransform, 'transformA,transformB');

      const feature = new TransformFeature();
      registry.collectFromFeature(feature);

      // 禁用 transformB
      registry.disableHook(CoreLifecycle.ToolResultTransform, 'TransformFeat', 'transformB');

      await registry.executeTransform(
        CoreLifecycle.ToolResultTransform,
        'initial',
        (current) => ({ result: current, toolName: 'test', call: {} as any, step: 0 }),
      );

      // 只有 A 被执行
      expect(transformedBy).toEqual(['A']);
    });
  });

  describe('getSnapshot', () => {
    it('snapshot entry 包含 enabled 字段且与实际状态一致', () => {
      const registry = new HooksRegistry();
      const feature = makeNotifyFeature('SnapFeat', 'hook', () => {});
      registry.collectFromFeature(feature);

      const snapshot = registry.getSnapshot();
      const stepStartGroup = snapshot.find(g => g.lifecycle === CoreLifecycle.StepStart);
      expect(stepStartGroup).toBeDefined();

      const entry = stepStartGroup!.entries.find(e => e.featureName === 'SnapFeat');
      expect(entry).toBeDefined();
      expect(entry!.enabled).toBe(true);

      // disable 后再检查
      registry.disableHook(CoreLifecycle.StepStart, 'SnapFeat', 'hook');
      const snapshot2 = registry.getSnapshot();
      const entry2 = snapshot2.find(g => g.lifecycle === CoreLifecycle.StepStart)!
        .entries.find(e => e.featureName === 'SnapFeat');
      expect(entry2!.enabled).toBe(false);
    });
  });

  describe('生命周期', () => {
    it('collectFromFeature 新注册的钩子 enabled 默认为 true', () => {
      const registry = new HooksRegistry();
      const feature = makeNotifyFeature('LifeFeat', 'hook', () => {});
      registry.collectFromFeature(feature);

      const hooks = registry.get(CoreLifecycle.StepStart);
      expect(hooks.length).toBe(1);
      expect(hooks[0].enabled).toBe(true);
    });

    it('removeFromFeature 移除的钩子不会残留', () => {
      const registry = new HooksRegistry();
      const feature = makeNotifyFeature('RemoveFeat', 'hook', () => {});
      registry.collectFromFeature(feature);

      registry.disableHook(CoreLifecycle.StepStart, 'RemoveFeat', 'hook');
      registry.removeFromFeature(feature);

      // 再注册回来，应该是 enabled
      registry.collectFromFeature(feature);
      const hooks = registry.get(CoreLifecycle.StepStart);
      expect(hooks[0].enabled).toBe(true);
    });

    it('clear 后所有状态归零', () => {
      const registry = new HooksRegistry();
      const feature = makeNotifyFeature('ClearFeat', 'hook', () => {});
      registry.collectFromFeature(feature);
      registry.disableHook(CoreLifecycle.StepStart, 'ClearFeat', 'hook');

      registry.clear();

      // 重新注册应该是 enabled
      registry.collectFromFeature(feature);
      const hooks = registry.get(CoreLifecycle.StepStart);
      expect(hooks[0].enabled).toBe(true);
    });
  });

  describe('executeTransform 跳过被禁用的变换钩子', () => {
    it('被禁用的 transform 钩子不修改数据', async () => {
      const registry = new HooksRegistry();

      class TransformFeature implements AgentFeature {
        name = 'TransformFeat';
        async doubleIt(_ctx: any) {
          return undefined; // 简化：不实际修改
        }
      }

      const proto = TransformFeature.prototype;
      const constructor = proto.constructor as any;
      if (!constructor._hookDecisions) {
        constructor._hookDecisions = new Map();
      }
      constructor._hookDecisions.set(CoreLifecycle.ToolResultTransform, 'doubleIt');

      const feature = new TransformFeature();
      let transformCalled = false;
      (feature as any).doubleIt = () => { transformCalled = true; return undefined; };

      registry.collectFromFeature(feature);
      registry.disableHook(CoreLifecycle.ToolResultTransform, 'TransformFeat', 'doubleIt');

      await registry.executeTransform(
        CoreLifecycle.ToolResultTransform,
        'data',
        (current) => ({ result: current, toolName: 'test', call: {} as any, step: 0 }),
      );

      expect(transformCalled).toBe(false);
    });
  });
});
