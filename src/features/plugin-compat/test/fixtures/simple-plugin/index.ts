/**
 * Simple Test Plugin
 *
 * 用于测试 OpenClaw 兼容层的简单插件
 */

import type {
  AgentDevOpenClawCompatApi,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
} from '../../../types.js';

/**
 * 插件注册函数
 */
export async function register(api: AgentDevOpenClawCompatApi): Promise<void> {
  api.logger.info('Registering simple-test-plugin...');

  // 注册一个简单的工具
  api.registerTool({
    name: 'simple_echo',
    description: 'Echo back the input message',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to echo back',
        },
      },
      required: ['message'],
    },
    execute: async (params: { args: Record<string, unknown>; context: any }) => {
      return `Echo: ${String(params.args.message ?? '')}`;
    },
  });

  // 注册 before_tool_call 钩子（高优先级）
  api.on('before_tool_call', async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult> => {
    api.logger.debug(`before_tool_call: ${ctx.toolName}`);

    // 示例：阻止危险工具调用
    if (ctx.toolName === 'rm' || ctx.toolName === 'delete') {
      return {
        block: true,
        denyReason: `Dangerous tool '${ctx.toolName}' is blocked by simple-test-plugin`,
      };
    }

    // 示例：修改参数
    if (ctx.toolName === 'simple_echo') {
      return {
        rewrittenParameters: {
          ...ctx.parameters,
          message: `[PLUGIN INTERCEPTED] ${ctx.parameters.message}`,
        },
      };
    }

    return {};
  }, { priority: 10 });

  // 注册 after_tool_call 钩子
  api.on('after_tool_call', async (ctx: AfterToolCallContext) => {
    api.logger.debug(`after_tool_call: ${ctx.toolName} - success: ${ctx.success}`);
  });
}

// 默认导出（备用）
export default register;
