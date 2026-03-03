/**
 * 测试反向钩子约束
 *
 * 验证：
 * 1. 非流程控制型钩子（void）可以在同一 Feature 内修饰多个方法
 * 2. 流程控制型钩子（DecisionResult）在同一 Feature 内只能修饰一个方法
 */

import { describe, it, expect } from 'bun:test';
import { StepFinish, ToolFinished, StepStart, ToolUse, Decision } from '../src/core/hooks-decorator.js';
import type { StepFinishDecisionContext, ToolFinishedDecisionContext, StepStartContext, ToolContext } from '../src/core/hooks-decorator.js';
import type { AgentFeature } from '../src/core/feature.js';

describe('反向钩子约束测试', () => {
  describe('流程控制型钩子（单例约束）', () => {
    it('StepFinish 在同一 Feature 内只能使用一次', () => {
      expect(() => {
        class InvalidFeature implements AgentFeature {
          name = 'InvalidFeature';

          @StepFinish
          async handler1(ctx: StepFinishDecisionContext) {
            return Decision.Approve;
          }

          @StepFinish
          async handler2(ctx: StepFinishDecisionContext) {
            return Decision.Deny;
          }
        }

        new InvalidFeature();
      }).toThrow('流程控制型装饰器 @StepFinish 在 InvalidFeature 中只能使用一次');
    });

    it('ToolFinished 在同一 Feature 内只能使用一次', () => {
      expect(() => {
        class InvalidFeature implements AgentFeature {
          name = 'InvalidFeature';

          @ToolFinished
          async handler1(ctx: ToolFinishedDecisionContext) {
            return Decision.Approve;
          }

          @ToolFinished
          async handler2(ctx: ToolFinishedDecisionContext) {
            return Decision.Deny;
          }
        }

        new InvalidFeature();
      }).toThrow('流程控制型装饰器 @ToolFinished 在 InvalidFeature 中只能使用一次');
    });
  });

  describe('非流程控制型钩子（允许多个）', () => {
    it('StepStart 可以在同一 Feature 内修饰多个方法', () => {
      expect(() => {
        class ValidFeature implements AgentFeature {
          name = 'ValidFeature';

          @StepStart
          async logStepStart(ctx: StepStartContext) {
            console.log('Step started (handler 1)');
          }

          @StepStart
          async trackMetrics(ctx: StepStartContext) {
            console.log('Tracking metrics (handler 2)');
          }
        }

        new ValidFeature();
      }).not.toThrow();
    });

    it('ToolUse 可以在同一 Feature 内修饰多个方法', () => {
      expect(() => {
        class ValidFeature implements AgentFeature {
          name = 'ValidFeature';

          @ToolUse
          async logToolUse(ctx: ToolContext) {
            console.log('Tool used (handler 1)');
          }

          @ToolUse
          async validateTool(ctx: ToolContext) {
            console.log('Validating tool (handler 2)');
          }
        }

        new ValidFeature();
      }).not.toThrow();
    });
  });

  describe('HooksRegistry 多方法注册测试', () => {
    it('应该正确注册和执行多个非流程控制型钩子', async () => {
      const { HooksRegistry } = await import('../src/core/hooks-registry.js');
      const { CoreLifecycle } = await import('../src/core/lifecycle.js');

      const registry = new HooksRegistry();
      const executionOrder: string[] = [];

      class MultiHookFeature implements AgentFeature {
        name = 'MultiHookFeature';

        @StepStart
        async firstHook(ctx: StepStartContext) {
          executionOrder.push('first');
        }

        @StepStart
        async secondHook(ctx: StepStartContext) {
          executionOrder.push('second');
        }

        @StepStart
        async thirdHook(ctx: StepStartContext) {
          executionOrder.push('third');
        }
      }

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
