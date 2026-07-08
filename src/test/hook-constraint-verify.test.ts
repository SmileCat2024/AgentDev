/**
 * 反向钩子约束验证
 */

import { describe, it, expect } from 'vitest';
import { StepFinish, StepStart, Decision, getDecoratorMetadata } from '../core/hooks-decorator.js';
import { HooksRegistry } from '../core/hooks-registry.js';
import { CoreLifecycle } from '../core/lifecycle.js';
import type { AgentFeature } from '../core/feature.js';
import type {
  StepFinishDecisionContext,
  StepStartContext,
} from '../core/lifecycle.js';

function applyMethodDecorator(
  decorator: (target: any, propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor,
  target: any,
  propertyKey: string
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
  expect(descriptor).toBeDefined();
  Object.defineProperty(target, propertyKey, decorator(target, propertyKey, descriptor!));
}

describe('Reverse hook constraints', () => {
  it('should limit decision hook to one method per feature', () => {
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

  it('should allow multiple notify hooks in declaration order', () => {
    class ValidFeature implements AgentFeature {
      name = 'ValidFeature';

      async logStart(_ctx: StepStartContext) {}
      async trackMetrics(_ctx: StepStartContext) {}
      async sendAnalytics(_ctx: StepStartContext) {}
    }

    applyMethodDecorator(StepStart, ValidFeature.prototype, 'logStart');
    applyMethodDecorator(StepStart, ValidFeature.prototype, 'trackMetrics');
    applyMethodDecorator(StepStart, ValidFeature.prototype, 'sendAnalytics');

    const metadata = getDecoratorMetadata(new ValidFeature());
    expect(metadata.hookDecisions.get(CoreLifecycle.StepStart)).toBe('logStart,trackMetrics,sendAnalytics');
  });

  it('should execute multiple notify hooks in order via registry', async () => {
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
    expect(hooks).toHaveLength(3);
    expect(hooks.map(hook => hook.methodName).join(',')).toBe('firstHook,secondHook,thirdHook');

    await registry.executeVoid(CoreLifecycle.StepStart, {
      step: 0,
      callIndex: 0,
      input: 'test',
      context: {} as any,
    });

    expect(executionOrder.join(',')).toBe('first,second,third');
  });

  it('should keep notify and decision hooks separate in mixed metadata', () => {
    class MixedFeature implements AgentFeature {
      name = 'MixedFeature';

      async beforeStep(_ctx: StepStartContext) {}
      async afterStep(_ctx: StepFinishDecisionContext) {
        return Decision.Approve;
      }
      async logStep(_ctx: StepStartContext) {}
    }

    applyMethodDecorator(StepStart, MixedFeature.prototype, 'beforeStep');
    applyMethodDecorator(StepFinish, MixedFeature.prototype, 'afterStep');
    applyMethodDecorator(StepStart, MixedFeature.prototype, 'logStep');

    const metadata = getDecoratorMetadata(new MixedFeature());
    expect(metadata.hookDecisions.get(CoreLifecycle.StepStart)).toBe('beforeStep,logStep');
    expect(metadata.hookDecisions.get(CoreLifecycle.StepFinish)).toBe('afterStep');
  });
});
