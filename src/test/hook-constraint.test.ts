/**
 * 测试反向钩子约束
 *
 * 验证：
 * 1. 非流程控制型钩子（void）可以在同一 Feature 内修饰多个方法
 * 2. 流程控制型钩子（DecisionResult）在同一 Feature 内只能修饰一个方法
 *
 * 注意：vitest 使用 esbuild 转译，不支持实验性装饰器语法（@Decorator）。
 * 这里使用 applyMethodDecorator 手动应用，与 hook-constraint-verify.test.ts 保持一致。
 */

import { describe, it, expect } from 'vitest';
import { StepFinish, ToolFinished, StepStart, ToolUse, Decision } from '../core/hooks-decorator.js';
import { HooksRegistry } from '../core/hooks-registry.js';
import { CoreLifecycle } from '../core/lifecycle.js';
import type { AgentFeature } from '../core/feature.js';
import type {
  StepFinishDecisionContext,
  ToolFinishedDecisionContext,
  StepStartContext,
  ToolContext,
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

describe('反向钩子约束测试', () => {
  describe('流程控制型钩子（单例约束）', () => {
    it('StepFinish 在同一 Feature 内只能使用一次', () => {
      class InvalidFeature implements AgentFeature {
        name = 'InvalidFeature';

        async handler1(_ctx: StepFinishDecisionContext) {
          return Decision.Approve;
        }

        async handler2(_ctx: StepFinishDecisionContext) {
          return Decision.Deny;
        }
      }

      applyMethodDecorator(StepFinish, InvalidFeature.prototype, 'handler1');

      expect(() => {
        applyMethodDecorator(StepFinish, InvalidFeature.prototype, 'handler2');
      }).toThrow(/只能使用一次/);
    });

    it('ToolUse 在同一 Feature 内只能使用一次', () => {
      class InvalidFeature implements AgentFeature {
        name = 'InvalidFeature';

        async handler1(_ctx: ToolContext) {
          return Decision.Approve;
        }

        async handler2(_ctx: ToolContext) {
          return Decision.Deny;
        }
      }

      applyMethodDecorator(ToolUse, InvalidFeature.prototype, 'handler1');

      expect(() => {
        applyMethodDecorator(ToolUse, InvalidFeature.prototype, 'handler2');
      }).toThrow(/只能使用一次/);
    });
  });

  describe('非流程控制型钩子（允许多个）', () => {
    it('StepStart 可以在同一 Feature 内修饰多个方法', () => {
      class ValidFeature implements AgentFeature {
        name = 'ValidFeature';

        async logStepStart(_ctx: StepStartContext) {}
        async trackMetrics(_ctx: StepStartContext) {}
      }

      expect(() => {
        applyMethodDecorator(StepStart, ValidFeature.prototype, 'logStepStart');
        applyMethodDecorator(StepStart, ValidFeature.prototype, 'trackMetrics');
        new ValidFeature();
      }).not.toThrow();
    });

    it('ToolFinished 可以在同一 Feature 内修饰多个方法', () => {
      class ValidFeature implements AgentFeature {
        name = 'ValidFeature';

        async logToolFinished(_ctx: ToolFinishedDecisionContext) {}
        async validateToolFinished(_ctx: ToolFinishedDecisionContext) {}
      }

      expect(() => {
        applyMethodDecorator(ToolFinished, ValidFeature.prototype, 'logToolFinished');
        applyMethodDecorator(ToolFinished, ValidFeature.prototype, 'validateToolFinished');
        new ValidFeature();
      }).not.toThrow();
    });
  });

  describe('HooksRegistry 多方法注册测试', () => {
    it('应该正确注册和执行多个非流程控制型钩子', async () => {
      const registry = new HooksRegistry();
      const executionOrder: string[] = [];

      class MultiHookFeature implements AgentFeature {
        name = 'MultiHookFeature';

        async firstHook(_ctx: StepStartContext) {
          executionOrder.push('first');
        }

        async secondHook(_ctx: StepStartContext) {
          executionOrder.push('second');
        }

        async thirdHook(_ctx: StepStartContext) {
          executionOrder.push('third');
        }
      }

      applyMethodDecorator(StepStart, MultiHookFeature.prototype, 'firstHook');
      applyMethodDecorator(StepStart, MultiHookFeature.prototype, 'secondHook');
      applyMethodDecorator(StepStart, MultiHookFeature.prototype, 'thirdHook');

      const feature = new MultiHookFeature();
      registry.collectFromFeature(feature);

      const hooks = registry.get(CoreLifecycle.StepStart);
      expect(hooks.length).toBe(3);
      expect(hooks[0].methodName).toBe('firstHook');
      expect(hooks[1].methodName).toBe('secondHook');
      expect(hooks[2].methodName).toBe('thirdHook');

      // 执行钩子验证顺序
      await registry.executeVoid(CoreLifecycle.StepStart, {
        step: 0,
        callIndex: 0,
        input: 'test',
        context: {} as any,
      });

      expect(executionOrder).toEqual(['first', 'second', 'third']);
    });
  });
});
