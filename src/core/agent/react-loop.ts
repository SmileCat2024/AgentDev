/**
 * ReAct 循环执行器
 *
 * 封装完整的 ReAct 循环逻辑
 *
 * 概念：
 * - Call（调用）: 用户一次完整的输入-输出交互
 * - Step（步骤）: ReAct 循环中的单次迭代（一次 LLM 调用 + 工具执行）
 */

import type { Context } from '../context.js';
import type { ToolExecResult } from '../context.js';
import type { ToolRegistry } from '../tool.js';
import type { ToolCall, LLMResponse, Message, UsageInfo, ImageInput } from '../types.js';
import type { ToolResult, HookResult, StepFinishDecisionContext } from '../lifecycle.js';
import type { CallFinishReason } from '../lifecycle.js';
import type { ReActContext, ReActResult, DebugPusher } from './types.js';
import type { AgentFeature } from '../feature.js';
import type { HooksRegistry } from '../hooks-registry.js';
import type { CallContinuationRequest } from '../continuation.js';
import { CoreLifecycle, Decision, normalizeDecision } from '../lifecycle.js';
import { createStepCheckpoint, rollbackToStepCheckpoint } from '../checkpoint.js';
import { createLogger, runWithLogScope } from '../logging.js';
import { ClassifiedAPIError } from '../../llm/api-errors.js';
import { getRetryDelay, sleep } from '../../llm/retry.js';

const logger = createLogger('agent.react');

/**
 * ReAct 循环执行器类
 */
export class ReActLoopRunner {
  private hooksRegistry: HooksRegistry;

  constructor(
    private agent: {
      llm: any;
      tools: ToolRegistry;
      maxTurns: number;  // 实际是 maxSteps，但保留兼容性
      debugEnabled: boolean;
      agentId?: string;
      _currentStep: number;
      _agentId?: string;
      _parentPool?: any;
      debugPusher?: DebugPusher;
      features?: Map<string, AgentFeature>;
      hooksRegistry: HooksRegistry;
      recordUsage(callIndex: number, step: number, usage: UsageInfo): void;
      endCallUsage(callIndex: number): void;
      stepSaveFn?: () => Promise<void>;
      peekContinuationRequest?: () => CallContinuationRequest | null;
    },
    private executeHookFn: (
      hookName: string,
      hookFn: () => Promise<any>,
      options: { input?: string; step?: number }
    ) => Promise<any>,
    private executeToolFn: (
      call: ToolCall,
      input: string,
      context: Context,
      step: number,
      callIndex: number
    ) => Promise<ToolExecResult>,
    private onStepStartFn: (ctx: any) => Promise<void>,
    private onStepFinishedFn: (ctx: any) => Promise<HookResult | undefined>,
    private onInterruptFn: (ctx: any) => Promise<void>
  ) {
    this.hooksRegistry = agent.hooksRegistry;
  }

  /**
   * 执行完整的 ReAct 循环
   *
   * @param input 用户输入
   * @param context 对话上下文
   * @param options 执行选项
   * @returns 执行结果
   */
  async run(input: string, context: Context, options: {
    isFirstCall: boolean;
    callIndex: number;  // 用户交互序号
    signal?: AbortSignal;
  }): Promise<ReActResult> {
    const { isFirstCall, callIndex, signal } = options;
    logger.debug('ReAct loop started', { callIndex, hasSignal: !!signal, signalAborted: signal?.aborted });

    // ========== ReAct 循环 ==========
    let completed = false;
    let finalResponse = '';
    let finishReason: CallFinishReason = 'max_steps';

    outerLoop:
    for (let step = 0; step < this.agent.maxTurns; step++) {
      const stepResult = await runWithLogScope({
        step,
        namespace: 'agent.step',
        tags: ['react-step', `step:${step}`],
      }, async () => {
        const checkpoint = createStepCheckpoint(context, this.agent.features);
        this.agent._currentStep = step;
        logger.debug('Step started', { step, callIndex });

        try {
          // 检查中断信号
          if (signal?.aborted) {
            logger.info('Step skipped due to interrupt', { step });
            return 'interrupted' as const;
          }

          // 推送消息到 DebugHub
          this.pushToDebug(context.getAll());

          // ========== Step Start ==========
          await this.executeHookFn(
            'onStepStart',
            () => this.onStepStartFn({ step, callIndex, context, input, agent: this.agent }),
            { input, step }
          );

          // 执行反向钩子 @StepStart（void 返回，仅做处理）
          await this.hooksRegistry.executeVoid(CoreLifecycle.StepStart, { step, callIndex, context, input, agent: this.agent });

          // 执行 LLM 调用（空响应时 step 内重试）
          const MAX_EMPTY_RETRIES = 5;
          let response: LLMResponse;
          let hasToolCalls = false;
          for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_RETRIES; emptyAttempt++) {
            const llmStartTime = Date.now();
            response = await runWithLogScope({
              lifecycle: 'LLM',
              namespace: 'agent.llm',
              tags: ['llm'],
            }, async () => await this.agent.llm.chat(
              context.getAll(),
              this.agent.tools.getAll(),
              signal ? { signal } : undefined
            ));
            const llmDuration = Date.now() - llmStartTime;

            logger.debug('LLM response received', {
              step,
              durationMs: llmDuration,
              toolCallsCount: response.toolCalls?.length ?? 0,
              hasContent: !!response.content,
              stopReason: response.stopReason,
            });

            // 收集用量数据
            if (response.usage) {
              this.agent.recordUsage(callIndex, step, response.usage);
            }

            hasToolCalls = !!(response.toolCalls && response.toolCalls.length > 0);

            // 空响应重试逻辑：无 content 且无 toolCalls
            if (!response.content && !hasToolCalls) {
              const stopReason = response.stopReason;
              const isLegitimateEmpty = stopReason === 'end_turn' || stopReason === 'stop';

              // stop_reason=max_tokens: 模型输出被 max_tokens 截断（通常是思考内容耗尽了全部预算）。
              // 重试不会改善结果，直接作为截断事件处理。
              // (参考 Claude Code claude.ts:2266 的 max_tokens 显式处理)
              const isMaxTokensTruncation = stopReason === 'max_tokens';

              if (isLegitimateEmpty) {
                // 合法空响应（模型主动结束但无内容），不重试
                this.pushToDebug([
                  ...context.getAll(),
                  { role: 'assistant', content: '[Info: LLM returned empty response with end_turn]', turn: callIndex },
                ]);
                break; // 跳出重试循环，进入正常完成流程
              }

              if (isMaxTokensTruncation) {
                logger.warn('LLM response truncated by max_tokens (empty content)', {
                  step,
                  callIndex,
                  stopReason,
                  hasReasoning: !!response.reasoning,
                });
                this.pushToDebug([
                  ...context.getAll(),
                  { role: 'assistant', content: '[Warning: LLM output was truncated by max_tokens — thinking consumed the entire token budget and no content was produced]', turn: callIndex },
                ]);
                break; // 不重试，直接结束本轮
              }

              // 异常空响应，尝试重试
              if (emptyAttempt < MAX_EMPTY_RETRIES) {
                const delayMs = getRetryDelay(emptyAttempt + 1);
                logger.info('LLM returned empty response, retrying in step', {
                  step,
                  callIndex,
                  attempt: emptyAttempt + 1,
                  delayMs,
                  stopReason,
                });
                this.pushToDebug([
                  ...context.getAll(),
                  { role: 'assistant', content: `[Info: LLM returned empty response (attempt ${emptyAttempt + 1}/${MAX_EMPTY_RETRIES}), retrying...]`, turn: callIndex },
                ]);
                // 检查中断信号
                if (signal?.aborted) {
                  logger.info('Empty response retry skipped due to interrupt', { step });
                  break;
                }
                await sleep(delayMs, signal);
                continue; // 重试 LLM 调用
              }

              // 重试耗尽
              logger.warn('LLM returned empty response after retries', {
                step,
                callIndex,
                attempts: MAX_EMPTY_RETRIES + 1,
                stopReason,
              });
              this.pushToDebug([
                ...context.getAll(),
                { role: 'assistant', content: '[Error: LLM returned empty response]', turn: callIndex },
              ]);
            } else {
              // 正常响应（有 content 或有 toolCalls），添加到 context
              context.addAssistantMessage(response, callIndex);
              this.pushToDebug(context.getAll());
            }
            break; // 正常响应或重试结束，跳出重试循环
          }

          if (!hasToolCalls) {
          // 无工具调用：执行 StepFinish 钩子
            const stepFinishResult = await this.executeHookFn(
              'onStepFinished',
              () => this.onStepFinishedFn({
                step,
                callIndex,
                context,
                input,
                agent: this.agent,
                llmResponse: response,
                toolCallsCount: 0,
              }),
              { input, step }
            );

          // 执行反向钩子 @StepFinish（有流程控制）
            const stepFinishDecisionCtx: StepFinishDecisionContext = {
              step,
              callIndex,
              context,
              input,
              agent: this.agent,
              llmResponse: response,
              toolCallsCount: 0,
              hasActiveSubAgents: this.checkActiveSubAgents(),
              hasPendingMessages: this.checkPendingMessages(),
              waitCalled: false,
            };
            const decisionResult = await this.hooksRegistry.executeDecision(CoreLifecycle.StepFinish, stepFinishDecisionCtx);
            const stepFinishDecision = normalizeDecision(decisionResult);

          // 处理钩子返回的控制流指令
             if (stepFinishResult?.action === 'end') {
               completed = true;
               finalResponse = response.content;
               finishReason = 'completed';
               logger.info('Step ended call via forward hook', { step });
               return 'break';
             }

           // 处理反向钩子的决策
             if (stepFinishDecision === Decision.Deny) {
               completed = true;
               finalResponse = response.content;
               finishReason = 'completed';
               logger.info('Step ended call via reverse hook deny', { step });
               return 'break';
             }

          // 如果反向钩子要求继续（Approve），不结束循环
            if (stepFinishDecision === Decision.Approve || stepFinishResult?.action === 'continue') {
              logger.debug('Step requested continuation without tools', { step });
              return 'continue';
            }

          // 真正结束
            logger.info('Step completed call naturally', { step });
            return { completed: true, finalResponse: response.content, turns: step + 1, finishReason: 'completed' };
          }

        // 执行工具
          let waitCalled = false;
          let interrupted = false;
          let batchRejected = false;

          // ========== Exclusive batch pre-check ==========
          // 如果批次中包含 exclusive 工具且不止一个工具调用，整批拒绝执行
          if (response.toolCalls.length > 1) {
            const exclusiveNames = response.toolCalls
              .filter(call => this.agent.tools.isExclusive(call.name))
              .map(call => call.name);

            if (exclusiveNames.length > 0) {
              batchRejected = true;
              const namesStr = exclusiveNames.join(', ');
              const errorMsg = exclusiveNames.length === 1
                ? `The exclusive tool [${namesStr}] must be the only tool call in this assistant turn. No tool in this batch was executed. Retry with only ${namesStr}.`
                : `Multiple exclusive tools [${namesStr}] were called together. Each exclusive tool must be the only tool call in its turn. No tool in this batch was executed. Retry with a single exclusive tool.`;

              for (const call of response.toolCalls) {
                const failResult: ToolExecResult = {
                  success: false,
                  result: { error: errorMsg },
                };
                context.addToolMessage(call, failResult, callIndex);
              }
              this.pushToDebug(context.getAll());
              logger.info('Exclusive batch violation, all tools rejected', { step, exclusiveNames, batchSize: response.toolCalls.length });
            }
          }

          // ========== 结果收集 Map ==========
          const resultsMap = new Map<string, ToolExecResult>();

          if (!batchRejected) {
            // ========== 分流 ==========
            const parallelCalls = response.toolCalls.filter(
              call => this.agent.tools.isParallelizable(call.name)
            );
            const serialCalls = response.toolCalls.filter(
              call => !this.agent.tools.isParallelizable(call.name)
            );

            // ========== Phase 1: 并发执行 parallelizable 工具 ==========
            if (parallelCalls.length > 0) {
              if (!signal?.aborted) {
                const parallelResults = await Promise.allSettled(
                  parallelCalls.map(call =>
                    this.executeToolFn(call, input, context, step, callIndex)
                  )
                );
                parallelCalls.forEach((call, i) => {
                  const settled = parallelResults[i];
                  if (settled.status === 'fulfilled') {
                    resultsMap.set(call.id, settled.value);
                  } else {
                    const errorMsg = settled.reason instanceof Error
                      ? settled.reason.message : String(settled.reason);
                    resultsMap.set(call.id, {
                      success: false,
                      result: { error: errorMsg },
                    });
                  }
                });
              } else {
                // 中断：为所有 parallelizable 工具补齐 interrupted result
                for (const call of parallelCalls) {
                  resultsMap.set(call.id, {
                    success: false,
                    result: { error: 'Interrupted by user' },
                  });
                }
                interrupted = true;
              }
            }

            // ========== Phase 2: 串行执行剩余工具 ==========
            for (let i = 0; i < serialCalls.length; i++) {
              const call = serialCalls[i];

              // 在执行每个工具前检查中断信号
              if (signal?.aborted) {
                interrupted = true;
                // 为当前及剩余的 serial 工具补齐 interrupted result
                for (let j = i; j < serialCalls.length; j++) {
                  resultsMap.set(serialCalls[j].id, {
                    success: false,
                    result: { error: 'Interrupted by user' },
                  });
                  logger.info('Tool result padded for interrupt', { toolName: serialCalls[j].name, toolIndex: j });
                }
                break;
              }

              if (call.name === 'wait') {
                waitCalled = true;
              }
              const result = await this.executeToolFn(call, input, context, step, callIndex);
              resultsMap.set(call.id, result);
            }

            // ========== 统一注入：按原始顺序写入 context ==========
            for (const call of response.toolCalls) {
              const result = resultsMap.get(call.id);
              if (result) {
                context.addToolMessage(call, result, callIndex);
              } else {
                // 安全网：结果缺失
                context.addToolMessage(call, {
                  success: false,
                  result: { error: 'Tool result missing (internal error)' },
                }, callIndex);
              }
            }
          } // end if (!batchRejected)

          // 如果在 tool 执行中被中断，结束当前 call
          // 同时检查 signal?.aborted：当 abort 在并行工具 race 或单个工具执行期间触发时，
          // interrupted 标志不会被设置（只有 pre-check 和 serial 循环头部会设），
          // 但工具已通过 ToolInterruptError 返回了 error result，此时应立即退出。
          if (interrupted || signal?.aborted) {
            this.pushToDebug(context.getAll());
            const lastContent = context.getAll().filter(m => m.role === 'assistant' && m.content).pop();
            finalResponse = lastContent?.content ?? response.content ?? '';
            completed = false;
            finishReason = 'interrupted';
            logger.info('Call interrupted during tool execution', { step });
            return 'interrupted' as const;
          }

          // ========== Continuation request check ==========
          // 控制工具（checkpoint/rollback）在执行期间可能登记了 continuation request。
          // 此时 tool result 已写入 Context，协议完整，可以安全结束当前 onCall segment。
          // 宿主将在 onCall 返回后通过 consumeContinuationRequest() 获取请求。
          const continuationRequest = this.agent.peekContinuationRequest?.();
          if (continuationRequest) {
            this.pushToDebug(context.getAll());
            const lastContent = context.getAll().filter(m => m.role === 'assistant' && m.content).pop();
            finalResponse = lastContent?.content ?? response.content ?? '';
            completed = false;
            logger.info('Call ending for continuation request', { step, kind: continuationRequest.kind });
            return { completed: false, finalResponse, turns: step + 1, continuationRequest, finishReason: 'continuation' };
          }

          // 推送消息到 DebugHub
          this.pushToDebug(context.getAll());

        // ========== Step Finished（有工具调用）==========
          const stepFinishResult = await this.executeHookFn(
            'onStepFinished',
            () => this.onStepFinishedFn({
              step,
              callIndex,
              context,
              input,
              agent: this.agent,
              llmResponse: response,
              toolCallsCount: response.toolCalls?.length ?? 0,
            }),
            { input, step }
          );

        // 执行反向钩子 @StepFinish（有流程控制）
          const stepFinishDecisionCtx: StepFinishDecisionContext = {
            step,
            callIndex,
            context,
            input,
            agent: this.agent,
            llmResponse: response,
            toolCallsCount: response.toolCalls?.length ?? 0,
            hasActiveSubAgents: this.checkActiveSubAgents(),
            hasPendingMessages: this.checkPendingMessages(),
            waitCalled,
          };
          const stepFinishDecisionResult = await this.hooksRegistry.executeDecision(CoreLifecycle.StepFinish, stepFinishDecisionCtx);
          const stepFinishDecision = normalizeDecision(stepFinishDecisionResult);

        // 处理钩子返回的控制流指令
           if (stepFinishResult?.action === 'end') {
             completed = true;
             finalResponse = response.content;
             finishReason = 'completed';
             logger.info('Step ended call after tools via forward hook', { step });
             return 'break';
           }

        // 处理反向钩子的决策
           if (stepFinishDecision === Decision.Deny) {
             completed = true;
             finalResponse = response.content;
             finishReason = 'completed';
             logger.info('Step ended call after tools via reverse hook deny', { step });
             return 'break';
           }

          if (stepFinishDecision === Decision.Approve || stepFinishResult?.action === 'continue') {
            logger.debug('Step requested continuation after tools', { step });
            return 'continue';
          }

          logger.debug('Step finished with tool calls, continuing loop by default', { step });
          return 'next';
        } catch (error) {
          // 如果是中断导致的错误，不回滚，直接传播
          if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            finishReason = 'interrupted';
            logger.info('Step aborted by interrupt signal', { step });
            return 'interrupted' as const;
          }

          await rollbackToStepCheckpoint(checkpoint, context, this.agent.features);

          // 根据错误类型生成不同的用户可见消息
          let errorMsg: string;
          let errorTag: string;

          if (error instanceof ClassifiedAPIError) {
            // 来自 LLM 层的分类错误 — 使用用户友好消息
            errorMsg = error.userMessage;
            errorTag = `[API Error: ${error.errorType}]`;
          } else {
            // 其他运行时错误 — 原始消息
            errorMsg = error instanceof Error ? error.message : String(error);
            errorTag = '[Error]';
          }

          // 错误消息进入 context，保持 context/viewer 一致性
          const fr: CallFinishReason = error instanceof ClassifiedAPIError ? 'api_error' : 'error';
          context.addAssistantMessage({ content: `${errorTag} ${errorMsg}` }, callIndex);
          this.pushToDebug(context.getAll());
          logger.warn('Step rolled back after failure', { step, errorType: error instanceof ClassifiedAPIError ? error.errorType : 'unknown', error: errorMsg });

          // 返回错误消息而非抛出，确保前端能在对话中看到错误说明
          return { completed: false, finalResponse: `${errorTag} ${errorMsg}`, turns: step + 1, finishReason: fr };
        }
      });

      // Step 完成后自动保存 session（如果启用了 stepSave）
      if (this.agent.stepSaveFn && stepResult !== 'interrupted') {
        try {
          await this.agent.stepSaveFn();
        } catch (saveError) {
          logger.warn('Step auto-save failed', { step, error: saveError instanceof Error ? saveError.message : String(saveError) });
        }
      }

      if (stepResult === 'break') {
        break;
      }
      if (stepResult === 'continue') {
        continue outerLoop;
      }
      if (stepResult === 'interrupted') {
        // 用户中断：不触发 onInterrupt 钩子（已在上面补齐 tool result）
        break;
      }
      if (typeof stepResult === 'object') {
        return stepResult;
      }

      // ========== Step 级别队列检查 ==========
      // 在每个 step 结束后检查是否有排队消息，如果有则注入并继续循环
      if (this.agent.agentId) {
        try {
          const queuedInput = await this.fetchQueuedInput(this.agent.agentId);
          if (queuedInput) {
            logger.info('Step 级别队列：注入排队消息', {
              step,
              queuedInput: queuedInput.text.slice(0, 100),
            });
            // 将排队消息作为新的用户输入注入 context
            context.addUserMessage(queuedInput.text, callIndex, queuedInput.images);
            // 推送到 DebugHub
            this.pushToDebug(context.getAll());
            // 继续循环，不要 break
            continue outerLoop;
          }
        } catch (e) {
          // 队列查询失败，忽略，继续正常流程
          logger.debug('队列查询失败，忽略', { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    // 未完成处理（max_steps 或 interrupted）
    if (!completed) {
      // 区分中断 vs 最大步数：中断时 signal.aborted 为 true
      if (signal?.aborted) {
        finishReason = 'interrupted';
      } else {
        finishReason = 'max_steps';
      }

      const partialResult = context.getAll()[context.getAll().length - 1]?.content || '';

      // 触发中断钩子
      const interruptResult = await this.executeHookFn(
        'onInterrupt',
        () => this.onInterruptFn({
          reason: signal?.aborted ? 'interrupted' : 'max_steps_reached',
          step: this.agent._currentStep,
          context,
        }),
        { input, step: this.agent._currentStep }
      );

      finalResponse = interruptResult as string ?? partialResult;
    }

    // 标记 Call 结束
    this.agent.endCallUsage(callIndex);

    return {
      finalResponse,
      completed,
      turns: this.agent._currentStep + 1,
      finishReason,
    };
  }

  /**
   * 从 ViewerWorker 获取并消费一条排队消息
   *
   * @param agentId Agent ID
   * @returns 排队消息（文本 + 图片），如果没有则返回 null
   */
  private async fetchQueuedInput(agentId: string): Promise<{ text: string; images?: ImageInput[] } | null> {
    // 从环境变量获取 ViewerWorker 端口
    const viewerPort = process.env.AGENTDEV_VIEWER_PORT || '2026';
    const viewerUrl = `http://127.0.0.1:${viewerPort}`;

    try {
      const res = await fetch(`${viewerUrl}/api/agents/${encodeURIComponent(agentId)}/dequeue-input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        return null;
      }

      const data = await res.json();
      if (data.input && data.input.text) {
        return {
          text: data.input.text,
          ...(Array.isArray(data.input.images) && data.input.images.length > 0
            ? { images: data.input.images }
            : {}),
        };
      }
      return null;
    } catch (e) {
      // 网络错误或 ViewerWorker 不可用
      return null;
    }
  }

  /**
   * 检查是否有活跃的子代理
   */
  private checkActiveSubAgents(): boolean {
    const subAgentFeature = this.agent.features?.get('subagent') as any;
    return subAgentFeature?.agentPool?.hasActiveAgents?.() ?? false;
  }

  /**
   * 检查是否有待处理的子代理消息
   */
  private checkPendingMessages(): boolean {
    const subAgentFeature = this.agent.features?.get('subagent') as any;
    return subAgentFeature?.agentPool?.hasPendingMessages?.() ?? false;
  }

  /**
   * 推送到 DebugHub
   */
  private pushToDebug(messages: Message[]): void {
    if (this.agent.debugEnabled && this.agent.agentId && this.agent.debugPusher) {
      this.agent.debugPusher.pushMessages(this.agent.agentId, messages);
    }
  }
}
