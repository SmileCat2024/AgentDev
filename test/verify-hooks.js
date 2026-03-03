/**
 * 验证反向钩子约束的简单脚本
 */

import { StepFinish, ToolFinished, StepStart, ToolUse, Decision } from '../src/core/hooks-decorator.js';

console.log('=== 测试 1: 流程控制型钩子（StepFinish）单例约束 ===');
try {
  class InvalidFeature1 {
    name = 'InvalidFeature1';

    @StepFinish
    async handler1(ctx) {
      return Decision.Approve;
    }

    @StepFinish
    async handler2(ctx) {
      return Decision.Deny;
    }
  }
  new InvalidFeature1();
  console.log('❌ 失败: 应该抛出错误但没有');
} catch (e) {
  if (e.message.includes('只能使用一次')) {
    console.log('✅ 成功: 正确抛出错误 -', e.message);
  } else {
    console.log('❌ 失败: 抛出了意外的错误 -', e.message);
  }
}

console.log('\n=== 测试 2: 流程控制型钩子（ToolFinished）单例约束 ===');
try {
  class InvalidFeature2 {
    name = 'InvalidFeature2';

    @ToolFinished
    async handler1(ctx) {
      return Decision.Approve;
    }

    @ToolFinished
    async handler2(ctx) {
      return Decision.Deny;
    }
  }
  new InvalidFeature2();
  console.log('❌ 失败: 应该抛出错误但没有');
} catch (e) {
  if (e.message.includes('只能使用一次')) {
    console.log('✅ 成功: 正确抛出错误 -', e.message);
  } else {
    console.log('❌ 失败: 抛出了意外的错误 -', e.message);
  }
}

console.log('\n=== 测试 3: 非流程控制型钩子（StepStart）允许多个 ===');
try {
  class ValidFeature1 {
    name = 'ValidFeature1';

    @StepStart
    async handler1(ctx) {
      console.log('  handler1 executed');
    }

    @StepStart
    async handler2(ctx) {
      console.log('  handler2 executed');
    }

    @StepStart
    async handler3(ctx) {
      console.log('  handler3 executed');
    }
  }
  new ValidFeature1();
  console.log('✅ 成功: 多个 StepStart 钩子正常注册');

  // 验证元数据
  const metadata = globalThis.getDecoratorMetadata?.(ValidFeature1);
  if (ValidFeature1._hookDecisions) {
    const methods = ValidFeature1._hookDecisions.get('StepStart');
    console.log('  注册的方法:', methods);
  }
} catch (e) {
  console.log('❌ 失败:', e.message);
}

console.log('\n=== 测试 4: 非流程控制型钩子（ToolUse）允许多个 ===');
try {
  class ValidFeature2 {
    name = 'ValidFeature2';

    @ToolUse
    async logTool(ctx) {
      console.log('  logTool executed');
    }

    @ToolUse
    async validateTool(ctx) {
      console.log('  validateTool executed');
    }
  }
  new ValidFeature2();
  console.log('✅ 成功: 多个 ToolUse 钩子正常注册');
} catch (e) {
  console.log('❌ 失败:', e.message);
}

console.log('\n=== 测试 5: HooksRegistry 多方法注册 ===');
try {
  const { HooksRegistry } = await import('../src/core/hooks-registry.js');
  const { CoreLifecycle } = await import('../src/core/lifecycle.js');

  const registry = new HooksRegistry();

  class MultiHookFeature {
    name = 'MultiHookFeature';

    @StepStart
    async firstHook(ctx) {}

    @StepStart
    async secondHook(ctx) {}

    @StepStart
    async thirdHook(ctx) {}
  }

  const feature = new MultiHookFeature();
  registry.collectFromFeature(feature);

  const hooks = registry.get(CoreLifecycle.StepStart);
  if (hooks.length === 3) {
    console.log('✅ 成功: 正确注册了 3 个钩子');
    console.log('  方法名:', hooks.map(h => h.methodName));
  } else {
    console.log(`❌ 失败: 期望 3 个钩子，实际 ${hooks.length} 个`);
  }
} catch (e) {
  console.log('❌ 失败:', e.message);
}

console.log('\n所有测试完成！');
