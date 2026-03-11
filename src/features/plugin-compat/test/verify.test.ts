/**
 * OpenClaw 兼容层验证脚本
 *
 * 运行方式：node dist/features/plugin-compat/test/verify.js
 */

import { PluginCompatFeature } from '../index.js';
import { CompatHookRegistry } from '../registry.js';
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
} from '../types.js';

console.log('=== OpenClaw 兼容层验证 ===\n');

// ========== 测试 1: CompatHookRegistry 优先级 ==========

console.log('【测试 1】钩子优先级排序');
console.log('-------------------');

const registry = new CompatHookRegistry();

// 注册多个钩子（不同优先级）
registry.register(
  'before_tool_call',
  async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult> => {
    console.log('  → Plugin A (priority=0) 执行');
    return {};
  },
  0,
  'plugin-a'
);

registry.register(
  'before_tool_call',
  async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult> => {
    console.log('  → Plugin B (priority=10) 执行');
    return {};
  },
  10,
  'plugin-b'
);

registry.register(
  'before_tool_call',
  async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult> => {
    console.log('  → Plugin C (priority=-5) 执行');
    return {};
  },
  -5,
  'plugin-c'
);

// 执行钩子验证顺序
console.log('执行顺序（应按 priority 降序：B → A → C）：');
await registry.executeBeforeToolCall({
  call: { id: '123', name: 'test', arguments: {} } as any,
  toolName: 'test',
  parameters: {},
  messages: [],
});

// ========== 测试 2: before_tool_call 阻断功能 ==========

console.log('\n【测试 2】before_tool_call 阻断功能');
console.log('-------------------');

const blockingRegistry = new CompatHookRegistry();

// 注册一个会阻断的钩子
blockingRegistry.register(
  'before_tool_call',
  async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult> => {
    if (ctx.toolName === 'dangerous_tool') {
      return {
        block: true,
        denyReason: 'Dangerous tool blocked',
      };
    }
    return {};
  },
  0,
  'security-plugin'
);

// 测试阻断
const result1 = await blockingRegistry.executeBeforeToolCall({
  call: { id: '123', name: 'dangerous_tool', arguments: {} } as any,
  toolName: 'dangerous_tool',
  parameters: {},
  messages: [],
});

console.log(`阻断测试: ${result1.block ? '✅ 正确阻止' : '❌ 未能阻止'} (${result1.denyReason})`);

// 测试通过
const result2 = await blockingRegistry.executeBeforeToolCall({
  call: { id: '123', name: 'safe_tool', arguments: {} } as any,
  toolName: 'safe_tool',
  parameters: {},
  messages: [],
});

console.log(`通过测试: ${!result2.block ? '✅ 正确通过' : '❌ 错误阻止'}`);

// ========== 测试 3: 参数修改功能 ==========

console.log('\n【测试 3】参数修改功能');
console.log('-------------------');

const rewritingRegistry = new CompatHookRegistry();

rewritingRegistry.register(
  'before_tool_call',
  async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult> => {
    if (ctx.toolName === 'echo') {
      return {
        rewrittenParameters: {
          message: `[MODIFIED] ${ctx.parameters.message}`,
        },
      };
    }
    return {};
  },
  0,
  'modifier-plugin'
);

const result3 = await rewritingRegistry.executeBeforeToolCall({
  call: { id: '123', name: 'echo', arguments: { message: 'hello' } } as any,
  toolName: 'echo',
  parameters: { message: 'hello' },
  messages: [],
});

if (result3.rewrittenParameters) {
  console.log(`✅ 参数已修改: ${result3.rewrittenParameters.message}`);
} else {
  console.log('❌ 参数未被修改');
}

// ========== 测试 4: after_tool_call 通知 ==========

console.log('\n【测试 4】after_tool_call 通知');
console.log('-------------------');

const afterCallRegistry = new CompatHookRegistry();

afterCallRegistry.register(
  'after_tool_call',
  async (ctx: AfterToolCallContext) => {
    console.log(`  → 工具 ${ctx.toolName} 执行 ${ctx.success ? '成功' : '失败'}`);
  },
  0,
  'logger-plugin'
);

await afterCallRegistry.executeAfterToolCall({
  call: { id: '123', name: 'test', arguments: {} } as any,
  toolName: 'test',
  success: true,
  result: 'done',
  duration: 100,
  messages: [],
});

console.log('\n=== 所有测试完成 ===');
