/**
 * 反向钩子约束验证
 */

import { StepFinish, StepStart, Decision, getDecoratorMetadata } from '../core/hooks-decorator.js';
import { HooksRegistry } from '../core/hooks-registry.js';
import { CoreLifecycle } from '../core/lifecycle.js';
import type { AgentFeature } from '../core/feature.js';
import type {
  StepFinishDecisionContext,
  StepStartContext,
} from '../core/lifecycle.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function applyMethodDecorator(
  decorator: (target: any, propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor,
  target: any,
  propertyKey: string
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
  assert(descriptor, `missing descriptor for ${propertyKey}`);
  Object.defineProperty(target, propertyKey, decorator(target, propertyKey, descriptor!));
}

async function testDecisionHookUniqueness(): Promise<void> {
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

  let errorMessage = '';
  try {
    applyMethodDecorator(StepFinish, InvalidFeature.prototype, 'handler2');
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  assert(errorMessage.includes('只能使用一次'), 'decision hook should be limited to one method per feature');
}

async function testMultipleNotifyHooks(): Promise<void> {
  class ValidFeature implements AgentFeature {
    name = 'ValidFeature';

    async logStart(_ctx: StepStartContext) {}
    async trackMetrics(_ctx: StepStartContext) {}
    async sendAnalytics(_ctx: StepStartContext) {}
  }

  applyMethodDecorator(StepStart, ValidFeature.prototype, 'logStart');
  applyMethodDecorator(StepStart, ValidFeature.prototype, 'trackMetrics');
  applyMethodDecorator(StepStart, ValidFeature.prototype, 'sendAnalytics');

  const feature = new ValidFeature();
  const metadata = getDecoratorMetadata(feature);
  assert(
    metadata.hookDecisions.get(CoreLifecycle.StepStart) === 'logStart,trackMetrics,sendAnalytics',
    'notify hooks should allow multiple methods in declaration order'
  );
}

async function testRegistryExecutesMultipleHooks(): Promise<void> {
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
  assert(hooks.length === 3, 'registry should collect all notify hook methods');
  assert(
    hooks.map(hook => hook.methodName).join(',') === 'firstHook,secondHook,thirdHook',
    'registry should preserve hook method names'
  );

  await registry.executeVoid(CoreLifecycle.StepStart, {
    step: 0,
    callIndex: 0,
    input: 'test',
    context: {} as any,
  });

  assert(
    executionOrder.join(',') === 'first,second,third',
    'registry should execute multiple notify hooks in order'
  );
}

async function testMixedHookMetadata(): Promise<void> {
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
  assert(metadata.hookDecisions.get(CoreLifecycle.StepStart) === 'beforeStep,logStep', 'mixed metadata should keep all notify hooks');
  assert(metadata.hookDecisions.get(CoreLifecycle.StepFinish) === 'afterStep', 'mixed metadata should keep decision hook');
}

await testDecisionHookUniqueness();
await testMultipleNotifyHooks();
await testRegistryExecutesMultipleHooks();
await testMixedHookMetadata();

console.log('Hook constraint tests passed');
