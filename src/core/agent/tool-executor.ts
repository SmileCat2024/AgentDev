/**
 * 工具执行器
 *
 * 封装单个工具的执行逻辑
 */

import type { ToolCall, Message } from '../types.js';
import type { ToolRegistry } from '../tool.js';
import type { Context } from '../context.js';
import type { AgentFeature, ContextInjector } from '../feature.js';
import type { ToolContext, ToolResult, HookResult, ToolFinishedDecisionContext } from '../lifecycle.js';
import type { ToolExecResult } from '../context.js';
import type { HooksRegistry } from '../hooks-registry.js';
import { CoreLifecycle, normalizeDecision, Decision } from '../lifecycle.js';
import { createLogger, runWithLogScope } from '../logging.js';

const logger = createLogger('agent.tool');

/**
 * 工具中断错误
 *
 * 当 AbortSignal 触发时，Promise.race 中此错误被抛出，
 * 使工具执行立即结束，不等实际工具完成。
 */
class ToolInterruptError extends Error {
  constructor() {
    super('Interrupted by user');
    this.name = 'AbortError';
  }
}

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
    private onToolFinishedFn: (result: ToolResult) => Promise<void>,
    private hooksRegistry: HooksRegistry
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
    return await runWithLogScope({
      step,
      toolName: call.name,
      toolCallId: call.id,
      feature: this.tools.getSource(call.name),
      namespace: 'agent.tool',
      tags: [
        'tool',
        `tool:${call.name}`,
        ...(this.tools.getSource(call.name) ? [`feature:${this.tools.getSource(call.name)}`] : []),
      ],
    }, async () => {
      const tool = this.tools.get(call.name);
      const startTime = Date.now();

      const toolCtx: ToolContext = {
        call,
        tool: tool!,
        step,
        input,
        context,
        getFeature: <T extends AgentFeature>(featureName: string): T | undefined => {
          return this.parentAgent.getFeature(featureName) as T | undefined;
        },
      };

      logger.info('Tool execution scheduled', {
        toolName: call.name,
        arguments: call.arguments,
        step,
      });

      if (tool && this.tools.isDisabled(call.name)) {
        const result: ToolResult = {
          success: false,
          data: null,
          error: 'This tool is currently disabled and cannot be used.',
          duration: Date.now() - startTime,
          call,
          tool,
          step,
          input,
          context,
          getFeature: <T extends AgentFeature>(featureName: string): T | undefined => {
            return this.parentAgent.getFeature(featureName) as T | undefined;
          },
        };

        logger.warn('Tool execution blocked', {
          toolName: call.name,
          reason: result.error,
        });

        const errorResult: ToolExecResult = {
          success: false,
          result: { error: result.error },
        };
        context.addToolMessage(call, errorResult, callIndex);

        await this.executeHookFn(
          'onToolFinished',
          () => this.onToolFinishedFn(result),
          { input, step }
        );

        const decisionCtx: ToolFinishedDecisionContext = {
          ...result,
          toolName: call.name,
        };
        await this.hooksRegistry.executeVoid(CoreLifecycle.ToolFinished, decisionCtx);

        return;
      }

      // ========== ToolUse 正向钩子 ==========
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

      // ========== ToolUse 反向钩子（流程控制）==========
      const useDecisionResult = await this.hooksRegistry.executeDecision(CoreLifecycle.ToolUse, toolCtx);
      const useDecision = normalizeDecision(useDecisionResult);

      // 处理反向钩子的决策
      if (useDecision === Decision.Deny) {
        blocked = true;
        blockReason = typeof useDecisionResult === 'object' && useDecisionResult.reason
          ? useDecisionResult.reason
          : 'Tool blocked by reverse hook';
      }

      const result: ToolResult = {
        success: false,
        data: null,
        error: this.tools.isDisabled(call.name)
          ? 'This tool is currently disabled and cannot be used.'
          : blockReason || (tool ? undefined : `Tool "${call.name}" not found`),
        duration: Date.now() - startTime,
        call,
        tool: tool!,
        step,
        input,
        context,
        getFeature: <T extends AgentFeature>(featureName: string): T | undefined => {
          return this.parentAgent.getFeature(featureName) as T | undefined;
        },
      };

      if (blocked || !tool || this.tools.isDisabled(call.name)) {
        logger.warn('Tool execution blocked', {
          toolName: call.name,
          reason: result.error,
        });

        // 添加阻止结果到上下文
        const errorResult: ToolExecResult = {
          success: false,
          result: { error: result.error || 'Tool not found' },
        };
        context.addToolMessage(call, errorResult, callIndex);

        // ========== ToolFinished 正向钩子 ==========
        await this.executeHookFn(
          'onToolFinished',
          () => this.onToolFinishedFn(result),
          { input, step }
        );

        // ========== ToolFinished 反向钩子（纯通知）==========
        const decisionCtx: ToolFinishedDecisionContext = {
          ...result,
          toolName: call.name,
        };
        await this.hooksRegistry.executeVoid(CoreLifecycle.ToolFinished, decisionCtx);

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

        // 传递 AbortSignal 给工具（支持中断）
        const signal = this.parentAgent._abortController?.signal;
        if (signal) {
          toolContext = { ...toolContext, signal };
        }

        // 注入 continuation request sink（供控制工具使用）
        toolContext = {
          ...toolContext,
          registerContinuationRequest: (request: import('../continuation.js').CallContinuationRequest) => {
            this.parentAgent.registerContinuationRequest(request);
          },
        };

        try {
          const { emitNotification, createToolStart } = await import('../notification.js');
          emitNotification(createToolStart(call.name));
        } catch {
          // Ignore notification failures.
        }

        // ========== 框架级中断 ==========
        // 将工具执行与 abort signal 竞争。
        // 当 signal abort 时立即返回，不等待工具完成。
        // 工具的实际执行在后台 fire-and-forget，其结果被丢弃。
        let data: unknown;
        if (signal) {
          // 已中断则直接跳过
          if (signal.aborted) {
            throw new ToolInterruptError();
          }
          // 创建 abort 监听 Promise
          const abortPromise = new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new ToolInterruptError()), { once: true });
          });
          data = await Promise.race([
            tool.execute(call.arguments, toolContext),
            abortPromise,
          ]);
        } else {
          data = await tool.execute(call.arguments, toolContext);
        }

        // 如果工具完成后发现已被中断，仍然标记为 interrupted
        if (signal?.aborted) {
          throw new ToolInterruptError();
        }

        result.success = true;
        result.data = data;

        // 添加工具结果到上下文
        const successResult: ToolExecResult = {
          success: true,
          result: typeof data === 'string' ? data : JSON.stringify(data),
        };
        context.addToolMessage(call, successResult, callIndex);

      } catch (error) {
        const isInterrupt = error instanceof ToolInterruptError
          || (error instanceof Error && error.name === 'AbortError');
        result.error = isInterrupt
          ? 'Interrupted by user'
          : (error instanceof Error ? error.message : String(error));

        // 添加错误结果到上下文
        const failResult: ToolExecResult = {
          success: false,
          result: { error: result.error },
        };
        context.addToolMessage(call, failResult, callIndex);
      }

      result.duration = Date.now() - startTime;

      try {
        const { emitNotification, createToolComplete } = await import('../notification.js');
        emitNotification(createToolComplete(call.name, result.success, result.duration));
      } catch {
        // Ignore notification failures.
      }

      // ========== ToolFinished 正向钩子 ==========
      await this.executeHookFn(
        'onToolFinished',
        () => this.onToolFinishedFn(result),
        { input, step }
      );

      // ========== ToolFinished 反向钩子（纯通知）==========
      const decisionCtx: ToolFinishedDecisionContext = {
        ...result,
        toolName: call.name,
      };
      await this.hooksRegistry.executeVoid(CoreLifecycle.ToolFinished, decisionCtx);

      if (result.success) {
        logger.info('Tool execution completed', {
          toolName: call.name,
          duration: result.duration,
        });
      } else {
        logger.error('Tool execution failed', {
          toolName: call.name,
          duration: result.duration,
          error: result.error,
        });
      }
    });
  }
}
