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
import type { ToolRegistry } from '../tool.js';
import type { ToolCall, LLMResponse, Message, UsageInfo } from '../types.js';
import type { ToolResult, HookResult, StepFinishDecisionContext } from '../lifecycle.js';
import type { ReActContext, ReActResult, DebugPusher } from './types.js';
import type { AgentFeature } from '../feature.js';
import type { HooksRegistry } from '../hooks-registry.js';
import { CoreLifecycle, Decision, normalizeDecision } from '../lifecycle.js';
import { createStepCheckpoint, rollbackToStepCheckpoint } from '../checkpoint.js';
import { createLogger, runWithLogScope } from '../logging.js';
import { ClassifiedAPIError } from '../../llm/api-errors.js';

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
    ) => Promise<void>,
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
    console.log(`[ReactLoop.run] START callIndex=${callIndex}, signal=${!!signal}, signal.aborted=${signal?.aborted}`);

    // ========== ReAct 循环 ==========
    let completed = false;
    let finalResponse = '';

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
          console.log(`[ReactLoop] step=${step} signal.aborted=${signal?.aborted}`);
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
          const MAX_EMPTY_RETRIES = 2;
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

              if (isLegitimateEmpty) {
                // 合法空响应（模型主动结束但无内容），不重试
                this.pushToDebug([
                  ...context.getAll(),
                  { role: 'assistant', content: '[Info: LLM returned empty response with end_turn]', turn: callIndex },
                ]);
                break; // 跳出重试循环，进入正常完成流程
              }

              // 异常空响应，尝试重试
              if (emptyAttempt < MAX_EMPTY_RETRIES) {
                logger.info('LLM returned empty response, retrying in step', {
                  step,
                  callIndex,
                  attempt: emptyAttempt + 1,
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
              logger.info('Step ended call via forward hook', { step });
              return 'break';
            }

          // 处理反向钩子的决策
            if (stepFinishDecision === Decision.Deny) {
              completed = true;
              finalResponse = response.content;
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
            return { completed: true, finalResponse: response.content, turns: step + 1 };
          }

        // 执行工具
          let waitCalled = false;
          let interrupted = false;
          console.log(`[ReactLoop] step=${step} executing ${response.toolCalls.length} toolCalls, signal.aborted=${signal?.aborted}`);
          for (let i = 0; i < response.toolCalls.length; i++) {
            const call = response.toolCalls[i];

            // 在执行每个工具前检查中断信号
            console.log(`[ReactLoop] step=${step} tool[${i}]="${call.name}" pre-execute signal.aborted=${signal?.aborted}`);
            if (signal?.aborted) {
              interrupted = true;
              // 为当前及剩余的 tool calls 补齐 interrupted result
              for (let j = i; j < response.toolCalls.length; j++) {
                const pendingCall = response.toolCalls[j];
                context.addToolMessage(pendingCall, {
                  success: false,
                  result: { error: 'Interrupted by user' },
                }, callIndex);
                logger.info('Tool result padded for interrupt', { toolName: pendingCall.name, toolIndex: j });
              }
              break;
            }

            if (call.name === 'wait') {
              waitCalled = true;
            }
            await this.executeToolFn(call, input, context, step, callIndex);
            console.log(`[ReactLoop] step=${step} tool[${i}]="${call.name}" post-execute done, signal.aborted=${signal?.aborted}`);
          }

          // 如果在 tool 执行中被中断，结束当前 call
          if (interrupted) {
            this.pushToDebug(context.getAll());
            const lastContent = context.getAll().filter(m => m.role === 'assistant' && m.content).pop();
            finalResponse = lastContent?.content ?? response.content ?? '';
            completed = false;
            logger.info('Call interrupted during tool execution', { step });
            return 'interrupted' as const;
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
            logger.info('Step ended call after tools via forward hook', { step });
            return 'break';
          }

        // 处理反向钩子的决策
          if (stepFinishDecision === Decision.Deny) {
            completed = true;
            finalResponse = response.content;
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
          context.addAssistantMessage({ content: `${errorTag} ${errorMsg}` }, callIndex);
          this.pushToDebug(context.getAll());
          logger.warn('Step rolled back after failure', { step, errorType: error instanceof ClassifiedAPIError ? error.errorType : 'unknown', error: errorMsg });

          // 返回错误消息而非抛出，确保前端能在对话中看到错误说明
          return { completed: false, finalResponse: `${errorTag} ${errorMsg}`, turns: step + 1 };
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
              queuedInput: queuedInput.slice(0, 100),
            });
            // 将排队消息作为新的用户输入注入 context
            context.addUserMessage(queuedInput, callIndex);
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

    // 达到最大步数 - 中断处理
    if (!completed) {
      const partialResult = context.getAll()[context.getAll().length - 1]?.content || '';

      // 触发中断钩子
      const interruptResult = await this.executeHookFn(
        'onInterrupt',
        () => this.onInterruptFn({
          reason: 'max_steps_reached',
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
    };
  }

  /**
   * 从 ViewerWorker 获取并消费一条排队消息
   *
   * @param agentId Agent ID
   * @returns 排队消息文本，如果没有则返回 null
   */
  private async fetchQueuedInput(agentId: string): Promise<string | null> {
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
        return data.input.text;
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
