/**
 * 验证反向钩子约束 - 使用编译后的代码
 */

import {
  StepFinish,
  ToolFinished,
  StepStart,
  ToolUse,
  getDecoratorMetadata
} from '../dist/core/hooks-decorator.js';
import { HooksRegistry } from '../dist/core/hooks-registry.js';
import { CoreLifecycle } from '../dist/core/lifecycle.js';

console.log('=== 测试 1: 流程控制型钩子（StepFinish）单例约束 ===');
try {
  class InvalidFeature1 {
    name = 'InvalidFeature1';
  }

  // 手动模拟装饰器行为
  const descriptor1 = {
    value: async function(ctx) { return 'approve'; },
    enumerable: false,
    configurable: true
  };
  const descriptor2 = {
    value: async function(ctx) { return 'deny'; },
    enumerable: false,
    configurable: true
  };

  // 第一次应用装饰器（应该成功）
  InvalidFeature1.prototype.handler1 = descriptor1.value;
  StepFinish(InvalidFeature1, 'handler1', descriptor1);

  // 第二次应用装饰器（应该失败）
  InvalidFeature1.prototype.handler2 = descriptor2.value;
  try {
    StepFinish(InvalidFeature1, 'handler2', descriptor2);
    console.log('❌ 失败: 应该抛出错误但没有');
  } catch (e) {
    if (e.message.includes('只能使用一次')) {
      console.log('✅ 成功: 正确抛出错误 -', e.message);
    } else {
      console.log('❌ 失败: 抛出了意外的错误 -', e.message);
    }
  }
} catch (e) {
  console.log('❌ 失败:', e.message);
}

console.log('\n=== 测试 2: 非流程控制型钩子（StepStart）允许多个 ===');
try {
  class ValidFeature1 {
    name = 'ValidFeature1';
  }

  const desc1 = { value: async function(ctx) {}, enumerable: false, configurable: true };
  const desc2 = { value: async function(ctx) {}, enumerable: false, configurable: true };
  const desc3 = { value: async function(ctx) {}, enumerable: false, configurable: true };

  ValidFeature1.prototype.handler1 = desc1.value;
  ValidFeature1.prototype.handler2 = desc2.value;
  ValidFeature1.prototype.handler3 = desc3.value;

  StepStart(ValidFeature1, 'handler1', desc1);
  StepStart(ValidFeature1, 'handler2', desc2);
  StepStart(ValidFeature1, 'handler3', desc3);

  console.log('✅ 成功: 多个 StepStart 钩子正常注册');

  // 验证元数据
  if (ValidFeature1._hookDecisions) {
    const methods = ValidFeature1._hookDecisions.get('stepStart');
    console.log('  注册的方法:', methods);
    if (methods === 'handler1,handler2,handler3') {
      console.log('  ✅ 方法列表正确');
    } else {
      console.log('  ❌ 方法列表错误，期望 "handler1,handler2,handler3"');
    }
  }
} catch (e) {
  console.log('❌ 失败:', e.message);
}

console.log('\n=== 测试 3: HooksRegistry 多方法注册 ===');
try {
  const registry = new HooksRegistry();

  class MultiHookFeature {
    name = 'MultiHookFeature';

    async firstHook(ctx) {}
    async secondHook(ctx) {}
    async thirdHook(ctx) {}
  }

  // 装饰器需要接收：target（类）、propertyKey、descriptor
  const desc1 = Object.getOwnPropertyDescriptor(MultiHookFeature.prototype, 'firstHook') ||
                { value: async function() {}, enumerable: false, configurable: true };
  const desc2 = Object.getOwnPropertyDescriptor(MultiHookFeature.prototype, 'secondHook') ||
                { value: async function() {}, enumerable: false, configurable: true };
  const desc3 = Object.getOwnPropertyDescriptor(MultiHookFeature.prototype, 'thirdHook') ||
                { value: async function() {}, enumerable: false, configurable: true };

  StepStart(MultiHookFeature.prototype, 'firstHook', desc1);
  StepStart(MultiHookFeature.prototype, 'secondHook', desc2);
  StepStart(MultiHookFeature.prototype, 'thirdHook', desc3);

  const feature = new MultiHookFeature();
  registry.collectFromFeature(feature);

  const hooks = registry.get(CoreLifecycle.StepStart);
  if (hooks.length === 3) {
    console.log('✅ 成功: 正确注册了 3 个钩子');
    console.log('  方法名:', hooks.map(h => h.methodName));
  } else {
    console.log(`❌ 失败: 期望 3 个钩子，实际 ${hooks.length} 个`);
  }

  // 打印调试信息
  const metadata = getDecoratorMetadata(feature);
  console.log('  调试 - 元数据:', {
    hookDecisions: Array.from(metadata.hookDecisions.entries())
  });
} catch (e) {
  console.log('❌ 失败:', e.message);
  console.log(e.stack);
}

console.log('\n所有测试完成！');
