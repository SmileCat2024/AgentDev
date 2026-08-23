/**
 * 工具执行器
 *
 * 封装单个工具的执行逻辑
 */

import type { ToolCall, Message, ToolExecutionContext, ToolTerminationReason } from '../types.js';
import type { ToolRegistry } from '../tool.js';
import type { Context } from '../context.js';
import type { AgentFeature, ContextInjector } from '../feature.js';
import type { ToolContext, ToolResult, HookResult, ToolFinishedDecisionContext, ToolResultTransformContext } from '../lifecycle.js';
import type { ToolExecResult } from '../context.js';
import type { HooksRegistry } from '../hooks-registry.js';
import { CoreLifecycle, normalizeDecision, Decision } from '../lifecycle.js';
import { isWithImagesResult } from '../tool-result-images.js';
import { isWithDisplayResult } from '../tool-result-display.js';
import { createLogger, runWithLogScope } from '../logging.js';

const logger = createLogger('agent.tool');

/**
 * settle 窗口时长（ticket 023 / ADR-0005）。
 *
 * 终止信号（超时/用户打断）触发后，不再立即 reject，而是给工具最多这个时长
 * 优雅收尾：窗口内 resolve 的结果正常返回（success: true + interrupted 标注）；
 * 超窗未收尾才降级为 ToolInterruptError 路径。
 */
export const TOOL_TERMINATION_SETTLE_MS = 1000;

/** 合并 controller 的终止原因 → 结果标注的 reason 映射相同；此处仅约束类型。 */
type TerminationSource = ToolTerminationReason;

/** 执行并清空清理函数列表（abort listener / 超时计时器等一次性资源）。 */
function runCleanupFns(fns: Array<() => void>): void {
  for (const fn of fns.splice(0)) {
    try {
      fn();
    } catch {
      // 清理失败不影响主流程
    }
  }
}

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
   * 工具成功返回值 → ToolExecResult（保留 images / display 分离协议，
   * 可选携带终止标注）。
   */
  private buildSuccessExecResult(
    data: unknown,
    interrupted?: { reason: TerminationSource },
  ): ToolExecResult {
    if (isWithImagesResult(data)) {
      return {
        success: true,
        result: data.text,
        images: data.images,
        ...(interrupted ? { interrupted } : {}),
      };
    }
    if (isWithDisplayResult(data)) {
      return {
        success: true,
        result: data.text,
        display: data.display,
        ...(interrupted ? { interrupted } : {}),
      };
    }
    return {
      success: true,
      result: typeof data === 'string' ? data : JSON.stringify(data),
      ...(interrupted ? { interrupted } : {}),
    };
  }

  /**
   * 执行单个工具
   */
  async execute(
    call: ToolCall,
    input: string,
    context: Context,
    step: number,
    callIndex: number  // 用户交互序号
  ): Promise<ToolExecResult> {
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

        await this.executeHookFn(
          'onToolFinished',
          () => this.onToolFinishedFn(result),
          { input, step }
        );

        const decisionCtx: ToolFinishedDecisionContext = {
          ...result,
          delivered: errorResult,
          toolName: call.name,
        };
        await this.hooksRegistry.executeVoid(CoreLifecycle.ToolFinished, decisionCtx);

        return errorResult;
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

        // ========== ToolFinished 正向钩子 ==========
        await this.executeHookFn(
          'onToolFinished',
          () => this.onToolFinishedFn(result),
          { input, step }
        );

        // ========== ToolFinished 反向钩子（纯通知）==========
        const decisionCtx: ToolFinishedDecisionContext = {
          ...result,
          delivered: errorResult,
          toolName: call.name,
        };
        await this.hooksRegistry.executeVoid(CoreLifecycle.ToolFinished, decisionCtx);

        return errorResult;
      }

      let execResult: ToolExecResult;

      // 一次性资源清理（超时计时器等）；正常路径在 race finally 中清理，
      // 异常路径由 catch 兜底，避免计时器泄漏挂住进程退出。
      const cleanupFns: Array<() => void> = [];

      try {
        // 执行工具
        // 使用声明的上下文注入器
        let toolContext: ToolExecutionContext | undefined = undefined;

        for (const { pattern, injector } of this.contextInjectors) {
          if (typeof pattern === 'string' && pattern === call.name) {
            toolContext = { ...(toolContext ?? {}), ...injector(call) };
          } else if (pattern instanceof RegExp && pattern.test(call.name)) {
            toolContext = { ...(toolContext ?? {}), ...injector(call) };
          }
        }

        // ========== 生效超时值（ticket 023）==========
        // clamp(fromArg ? args[fromArg] : defaultMs, 1, maxMs)
        // 未声明 timeout 的工具不受框架超时管辖，行为完全不变。
        const timeoutSpec = tool?.timeout;
        let timeoutMs: number | undefined;
        if (timeoutSpec && typeof timeoutSpec.defaultMs === 'number' && typeof timeoutSpec.maxMs === 'number' && timeoutSpec.maxMs > 0) {
          const requested = timeoutSpec.fromArg
            ? (call.arguments as Record<string, unknown>)?.[timeoutSpec.fromArg]
            : timeoutSpec.defaultMs;
          timeoutMs = Math.min(
            Math.max(Number.isFinite(requested) ? Number(requested) : timeoutSpec.defaultMs, 1),
            timeoutSpec.maxMs,
          );
        }

        // 注入 continuation request sink（供控制工具使用）
        toolContext = {
          ...(toolContext ?? {}),
          registerContinuationRequest: (request: import('../continuation.js').CallContinuationRequest) => {
            this.parentAgent.registerContinuationRequest(request);
          },
        };

        // 注入 callId 与终止原因查询函数（progress 配对 / 工具填写终止元数据）。
        // 纯增量注入：未声明 timeout 的工具不读取即无感；legacy 路径下
        // termination() 恒返回 null。
        toolContext = {
          ...toolContext,
          ...(call.id !== undefined ? { callId: call.id } : {}),
          termination: (): ToolTerminationReason | null => null,
        };

        try {
          const { emitNotification, createToolStart } = await import('../notification.js');
          emitNotification(createToolStart(call.name));
        } catch {
          // Ignore notification failures.
        }

        // ========== 框架级终止（ticket 023 / ADR-0005）==========
        let data: unknown;

        if (timeoutMs === undefined) {
          // ---------- 未声明 timeout：现状路径，行为与改动前逐字节一致 ----------
          const signal = this.parentAgent._abortController?.signal;
          if (signal) {
            toolContext = { ...toolContext, signal };
          }
          // 已中断则直接跳过
          if (signal?.aborted) {
            throw new ToolInterruptError();
          }
          if (signal) {
            // 将工具执行与 abort signal 竞争。
            // 当 signal abort 时立即返回，不等待工具完成。
            // 工具的实际执行在后台 fire-and-forget，其结果被丢弃。
            let removeAbortListener: (() => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
              const onAbort = () => reject(new ToolInterruptError());
              signal.addEventListener('abort', onAbort, { once: true });
              removeAbortListener = () => signal.removeEventListener('abort', onAbort);
            });
            try {
              data = await Promise.race([
                tool.execute(call.arguments, toolContext),
                abortPromise,
              ]);
            } finally {
              removeAbortListener?.();
            }
            // 如果工具完成后发现已被中断，仍然标记为 interrupted
            if (signal.aborted) {
              throw new ToolInterruptError();
            }
          } else {
            data = await tool.execute(call.arguments, toolContext);
          }

          result.success = true;
          result.data = data;

          execResult = this.buildSuccessExecResult(data);

        } else {
          // ---------- 声明 timeout：合并 signal + settle 窗口 ----------
          const externalSignal = this.parentAgent._abortController?.signal;
          let terminationReason: TerminationSource | null = null;

          // per-call 合并 AbortController：外部用户中断与框架超时汇入同一个
          // 合并 signal 传给工具；终止原因由执行器记录，经 termination()
          // 查询（不往 AbortSignal 上挂非标属性）。
          const mergedController = new AbortController();
          let cleanupExternalListener: (() => void) | undefined;
          if (externalSignal) {
            const onExternalAbort = () => {
              if (terminationReason === null) {
                terminationReason = 'user';
              }
              mergedController.abort(externalSignal.reason);
            };
            if (externalSignal.aborted) {
              onExternalAbort();
            } else {
              externalSignal.addEventListener('abort', onExternalAbort, { once: true });
              cleanupExternalListener = () => externalSignal.removeEventListener('abort', onExternalAbort);
            }
          }

          const timeoutTimer = setTimeout(() => {
            if (!mergedController.signal.aborted) {
              terminationReason = 'timeout';
            }
            mergedController.abort(new Error(`Tool timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          // 注册到统一清理：覆盖内层 race 之前提前 throw 的路径
          // （如下方 signal.aborted 预检查），保证计时器必然被回收
          cleanupFns.push(() => clearTimeout(timeoutTimer));

          const signal = mergedController.signal;
          toolContext = { ...toolContext, signal };

          // 覆盖 termination()：接通本调用的终止原因记录；
          // 暴露生效 timeoutMs（进度发射用，ticket 025）
          toolContext = {
            ...toolContext,
            termination: () => terminationReason,
            timeoutMs,
          };

          // 终止信号触发后不再立即 reject：先给工具最多 TOOL_TERMINATION_SETTLE_MS
          // 的 settle 窗口优雅收尾。窗口内 resolve → 结果正常返回并标注 interrupted；
          // 窗口内 throw → 走下方现有 catch；超窗未收尾 → 降级为 ToolInterruptError。
          try {
            // 已中断则直接跳过 settle（无输出可保留）
            if (signal.aborted) {
              throw new ToolInterruptError();
            }
            // 创建 abort 监听 Promise，并在 race 结束后清理 listener
            let removeAbortListener: (() => void) | undefined;
            const abortPromise = new Promise<'aborted'>((resolve) => {
              const onAbort = () => resolve('aborted');
              signal.addEventListener('abort', onAbort, { once: true });
              removeAbortListener = () => signal.removeEventListener('abort', onAbort);
            });
            const toolPromise = tool.execute(call.arguments, toolContext);
            try {
              const raced = await Promise.race([
                toolPromise.then(() => 'completed' as const),
                abortPromise,
              ]);
              if (raced === 'completed') {
                data = await toolPromise;
              } else {
                // 进入 settle 窗口：等工具在窗口内自行收尾
                let settled = false;
                let fireSettleExpiry: (() => void) | undefined;
                const settlePromise = new Promise<'expired'>((resolve) => {
                  fireSettleExpiry = () => resolve('expired');
                });
                const settleTimer = setTimeout(() => fireSettleExpiry?.(), TOOL_TERMINATION_SETTLE_MS);
                // 工具先收尾时回收窗口定时器（Promise.race 不会取消输家）
                cleanupFns.push(() => clearTimeout(settleTimer));
                try {
                  const settleRaced = await Promise.race([
                    toolPromise.then(() => { settled = true; return 'settled' as const; }),
                    settlePromise,
                  ]);
                  if (settleRaced === 'settled') {
                    data = await toolPromise;
                    // settle 窗口内完成但原因缺失（如工具自 abort），以用户中断兜底标注
                    if (terminationReason === null) {
                      terminationReason = 'user';
                    }
                  }
                } finally {
                  // settle 结束后若工具仍在跑，静默回收其结果/错误，避免 unhandled rejection
                  if (!settled) {
                    void toolPromise.catch(() => {});
                  }
                }
                if (!settled) {
                  throw new ToolInterruptError();
                }
              }
            } finally {
              removeAbortListener?.();
              clearTimeout(timeoutTimer);
              cleanupExternalListener?.();
            }
          } finally {
            runCleanupFns(cleanupFns);
          }

          result.success = true;
          result.data = data;

          const interruptedMeta = terminationReason !== null
            ? { reason: terminationReason }
            : undefined;

          execResult = this.buildSuccessExecResult(data, interruptedMeta);
        }

      } catch (error) {
        runCleanupFns(cleanupFns);
        const isInterrupt = error instanceof ToolInterruptError
          || (error instanceof Error && error.name === 'AbortError');
        result.error = isInterrupt
          ? 'Interrupted by user'
          : (error instanceof Error ? error.message : String(error));

        execResult = {
          success: false,
          result: { error: result.error },
        };
      }

      // ========== ToolResultTransform 反向钩子（数据变换）==========
      // 在结果写入 context 前，允许 Feature 对结果进行变换（如截断、脱敏）。
      // 变换在 ToolFinished 通知之前执行，这样通知钩子看到的是最终结果。
      execResult = await this.hooksRegistry.executeTransform<ToolExecResult>(
        CoreLifecycle.ToolResultTransform,
        execResult,
        (current) => ({
          toolName: call.name,
          call,
          result: current,
          step,
        } satisfies ToolResultTransformContext),
      );

      result.duration = Date.now() - startTime;

      // feature 事件流（C 项）：tool.executed 事件（scope 提供 feature/toolName context）
      logger.info(`tool ${call.name} executed`, {
        event: 'tool.executed',
        durationMs: result.duration,
        success: result.success,
      });

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
        delivered: execResult,
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

      return execResult;
    });
  }
}
