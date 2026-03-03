/**
 * 简单验证脚本 - 直接使用 TypeScript
 */

import {
  StepFinish,
  ToolFinished,
  StepStart,
  ToolUse,
  getDecoratorMetadata,
  Decision
} from '../src/core/hooks-decorator.js';
import { HooksRegistry } from '../src/core/hooks-registry.js';
import { CoreLifecycle } from '../src/core/lifecycle.js';
import type { AgentFeature } from '../src/core/feature.js';

console.log('=== 测试 1: 流程控制型钩子（StepFinish）单例约束 ===\n');
try {
  class InvalidFeature1 implements AgentFeature {
    name = 'InvalidFeature1';

    @StepFinish
    async handler1(ctx: any) {
      return Decision.Approve;
    }

    @StepFinish
    async handler2(ctx: any) {
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
    async logStart(ctx: any) {
      console.log('   [logStart] Step started');
    }

    @StepStart
    async trackMetrics(ctx: any) {
      console.log('   [trackMetrics] Tracking metrics');
    }

    @StepStart
    async sendAnalytics(ctx: any) {
      console.log('   [sendAnalytics] Sending analytics');
    }
  }

  console.log('✅ 成功: 多个 StepStart 钩子正常注册');

  // 验证元数据
  const feature1 = new ValidFeature1();
  const metadata = getDecoratorMetadata(feature1);
  const methods = metadata.hookDecisions.get(CoreLifecycle.StepStart);
  console.log('   注册的方法列表:', methods);

  if (methods === 'logStart,trackMetrics,sendAnalytics') {
    console.log('   ✅ 方法列表格式正确');
  } else {
    console.log('   ❌ 方法列表格式错误');
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
    async firstHook(ctx: any) {
      executionOrder.push('first');
    }

    @StepStart
    async secondHook(ctx: any) {
      executionOrder.push('second');
    }

    @StepStart
    async thirdHook(ctx: any) {
      executionOrder.push('third');
    }
  }

  const feature = new MultiHookFeature();
  registry.collectFromFeature(feature);

  const hooks = registry.get(CoreLifecycle.StepStart);
  console.log(`注册的钩子数量: ${hooks.length}`);
  console.log('钩子方法名:', hooks.map(h => h.methodName));

  if (hooks.length === 3) {
    console.log('✅ 成功: 正确注册了 3 个钩子');
  } else {
    console.log('❌ 失败: 期望 3 个钩子，实际', hooks.length);
  }

  // 执行钩子
  await registry.executeVoid(CoreLifecycle.StepStart, {
    step: 0,
    callIndex: 0,
    input: 'test',
    context: {} as any,
  });

  console.log('执行顺序:', executionOrder);
  if (JSON.stringify(executionOrder) === JSON.stringify(['first', 'second', 'third'])) {
    console.log('✅ 成功: 钩子按正确顺序执行');
  } else {
    console.log('❌ 失败: 钩子执行顺序不正确');
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
    async beforeStep(ctx: any) {
      console.log('   [beforeStep] Before step logic');
    }

    @StepFinish
    async afterStep(ctx: any) {
      return Decision.Approve;
    }

    @StepStart
    async logStep(ctx: any) {
      console.log('   [logStep] Logging step');
    }
  }

  console.log('✅ 成功: 混合钩子正常注册');
} catch (e: any) {
  console.log('❌ 失败:', e.message);
}

console.log('\n=== 所有测试完成 ===');
