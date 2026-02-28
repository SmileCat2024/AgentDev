/**
 * 工具执行器
 *
 * 封装单个工具的执行逻辑
 */

import type { ToolCall, Message } from '../types.js';
import type { ToolRegistry } from '../tool.js';
import type { Context } from '../context.js';
import type { ContextInjector } from '../feature.js';
import type { ToolContext, ToolResult, HookResult } from '../lifecycle.js';
import type { ToolExecResult } from '../context.js';

/**
 * 工具执行器类
 */
export class ToolExecutor {
  constructor(
    private tools: ToolRegistry,
    private contextInjectors: Array<{
      pattern: string | RegExp;
      injector: ContextInjector;
    }>,
    private parentAgent: any,
    private executeHookFn: (
      hookName: string,
      hookFn: () => Promise<any>,
      options: { input?: string; step?: number }
    ) => Promise<any>,
    private onToolUseFn: (ctx: ToolContext) => Promise<HookResult | undefined>,
    private onToolFinishedFn: (result: ToolResult) => Promise<void>
  ) {}

  /**
   * 执行单个工具
   */
  async execute(
    call: ToolCall,
    input: string,
    context: Context,
    step: number,
    callIndex: number  // 用户交互序号
  ): Promise<void> {
    const tool = this.tools.get(call.name);
    const startTime = Date.now();

    const toolCtx: ToolContext = {
      call,
      tool: tool!,
      step,
      input,
      context,
    };

    // 前置钩子
    let blocked = false;
    let blockReason: string | undefined;

    const hookResult = await this.executeHookFn(
      'onToolUse',
      () => this.onToolUseFn(toolCtx),
      { input, step }
    );

    if (hookResult) {
      if (hookResult.action === 'block') {
        blocked = true;
        blockReason = hookResult.reason;
      }
      // action: 'allow' 或 undefined 都放行
    }

    const result: ToolResult = {
      success: false,
      data: null,
      error: blockReason || (tool ? undefined : `Tool "${call.name}" not found`),
      duration: Date.now() - startTime,
      call,
      tool: tool!,
      step,
      input,
      context,
    };

    if (blocked || !tool) {
      // 添加阻止结果到上下文
      const errorResult: ToolExecResult = {
        success: false,
        result: { error: result.error || 'Tool not found' },
      };
      context.addToolMessage(call, errorResult, callIndex);
      await this.executeHookFn(
        'onToolFinished',
        () => this.onToolFinishedFn(result),
        { input, step }
      );
      return;
    }

    try {
      // 执行工具
      // 使用声明的上下文注入器
      let toolContext: any = undefined;

      for (const { pattern, injector } of this.contextInjectors) {
        if (typeof pattern === 'string' && pattern === call.name) {
          toolContext = { ...toolContext, ...injector(call) };
        } else if (pattern instanceof RegExp && pattern.test(call.name)) {
          toolContext = { ...toolContext, ...injector(call) };
        }
      }

      const data = await tool.execute(call.arguments, toolContext);
      result.success = true;
      result.data = data;

      // 添加工具结果到上下文
      const successResult: ToolExecResult = {
        success: true,
        result: typeof data === 'string' ? data : JSON.stringify(data),
      };
      context.addToolMessage(call, successResult, callIndex);

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);

      // 添加错误结果到上下文
      const failResult: ToolExecResult = {
        success: false,
        result: { error: result.error },
      };
      context.addToolMessage(call, failResult, callIndex);
    }

    result.duration = Date.now() - startTime;

    // 后置钩子
    await this.executeHookFn(
      'onToolFinished',
      () => this.onToolFinishedFn(result),
      { input, step }
    );
  }
}
