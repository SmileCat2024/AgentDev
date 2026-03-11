/**
 * 反向钩子约束验证
 *
 * 运行方式：编译后执行 node dist/test/hook-constraint-verify.js
 */

import { StepFinish, ToolFinished, StepStart, ToolUse, Decision, getDecoratorMetadata } from '../core/hooks-decorator.js';
import { HooksRegistry } from '../core/hooks-registry.js';
import { CoreLifecycle } from '../core/lifecycle.js';
import type { AgentFeature } from '../core/feature.js';
import type {
  StepFinishDecisionContext,
  ToolFinishedDecisionContext,
  StepStartContext,
  ToolContext
} from '../core/lifecycle.js';

console.log('=== 测试 1: 流程控制型钩子（StepFinish）单例约束 ===\n');

// 测试单例约束
try {
  class InvalidFeature1 implements AgentFeature {
    name = 'InvalidFeature1';

    @StepFinish
    async handler1(ctx: StepFinishDecisionContext) {
      return Decision.Approve;
    }

    @StepFinish
    async handler2(ctx: StepFinishDecisionContext) {
      return Decision.Deny;
    }
  }

  console.log('❌ 失败: 应该抛出错误但没有');
} catch (e: any) {
  if (e.message.includes('只能使用一次')) {
    console.log('✅ 成功: 正确抛出错误');
    console.log('   错误信息:', e.message);
  } else {
    console.log('❌ 失败: 抛出了意外的错误 -', e.message);
  }
}

console.log('\n=== 测试 2: 非流程控制型钩子（StepStart）允许多个 ===\n');

try {
  class ValidFeature1 implements AgentFeature {
    name = 'ValidFeature1';

    @StepStart
    async logStart(ctx: StepStartContext) {
      console.log('   [logStart] executed');
    }

    @StepStart
    async trackMetrics(ctx: StepStartContext) {
      console.log('   [trackMetrics] executed');
    }

    @StepStart
    async sendAnalytics(ctx: StepStartContext) {
      console.log('   [sendAnalytics] executed');
    }
  }

  console.log('✅ 成功: 多个 StepStart 钩子正常注册');

  const feature1 = new ValidFeature1();
  const metadata = getDecoratorMetadata(feature1);
  const methods = metadata.hookDecisions.get(CoreLifecycle.StepStart);
  console.log('   注册的方法列表:', methods);

  if (methods === 'logStart,trackMetrics,sendAnalytics') {
    console.log('   ✅ 方法列表格式正确');
  } else {
    console.log('   ❌ 方法列表格式错误，期望 "logStart,trackMetrics,sendAnalytics"');
  }
} catch (e: any) {
  console.log('❌ 失败:', e.message);
}

console.log('\n=== 测试 3: HooksRegistry 多方法注册与执行 ===\n');

try {
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
  console.log(`   注册的钩子数量: ${hooks.length}`);
  console.log('   钩子方法名:', hooks.map(h => h.methodName).join(', '));

  if (hooks.length === 3) {
    console.log('   ✅ 注册数量正确');
  } else {
    console.log(`   ❌ 注册数量错误: 期望 3，实际 ${hooks.length}`);
  }

  // 执行钩子
  await registry.executeVoid(CoreLifecycle.StepStart, {
    step: 0,
    callIndex: 0,
    input: 'test',
    context: {} as any,
  });

  console.log('   执行顺序:', executionOrder.join(' -> '));
  if (JSON.stringify(executionOrder) === JSON.stringify(['first', 'second', 'third'])) {
    console.log('   ✅ 执行顺序正确');
  } else {
    console.log('   ❌ 执行顺序错误');
  }
} catch (e: any) {
  console.log('❌ 失败:', e.message);
  console.log(e.stack);
}

console.log('\n=== 测试 4: 混合使用流程控制型和非流程控制型钩子 ===\n');

try {
  class MixedFeature implements AgentFeature {
    name = 'MixedFeature';

    @StepStart
    async beforeStep(ctx: StepStartContext) {
      console.log('   [beforeStep] Before step logic');
    }

    @StepFinish
    async afterStep(ctx: StepFinishDecisionContext) {
      return Decision.Approve;
    }

    @StepStart
    async logStep(ctx: StepStartContext) {
      console.log('   [logStep] Logging step');
    }
  }

  const mixedFeature = new MixedFeature();
  const metadata = getDecoratorMetadata(mixedFeature);

  console.log('✅ 成功: 混合钩子正常注册');
  console.log('   StepStart 方法:', metadata.hookDecisions.get(CoreLifecycle.StepStart));
  console.log('   StepFinish 方法:', metadata.hookDecisions.get(CoreLifecycle.StepFinish));
} catch (e: any) {
  console.log('❌ 失败:', e.message);
}

console.log('\n=== 所有测试完成 ===\n');
