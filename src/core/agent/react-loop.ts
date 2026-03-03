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
import type { ToolCall, LLMResponse, Message } from '../types.js';
import type { ToolResult, HookResult, StepFinishDecisionContext } from '../lifecycle.js';
import type { ReActContext, ReActResult, DebugPusher } from './types.js';
import type { AgentFeature } from '../feature.js';
import type { HooksRegistry } from '../hooks-registry.js';
import { CoreLifecycle, Decision, normalizeDecision } from '../lifecycle.js';

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
  }): Promise<ReActResult> {
    const { isFirstCall, callIndex } = options;

    // ========== ReAct 循环 ==========
    let completed = false;
    let finalResponse = '';

    outerLoop:
    for (let step = 0; step < this.agent.maxTurns; step++) {
      this.agent._currentStep = step;

      // 推送消息到 DebugHub
      this.pushToDebug(context.getAll());

      // ========== Step Start ==========
      await this.executeHookFn(
        'onStepStart',
        () => this.onStepStartFn({ step, callIndex, context, input }),
        { input, step }
      );

      // 执行反向钩子 @StepStart（void 返回，仅做处理）
      await this.hooksRegistry.executeVoid(CoreLifecycle.StepStart, { step, callIndex, context, input });

      // 执行 LLM 调用
      const llmStartTime = Date.now();
      const response = await this.agent.llm.chat(
        context.getAll(),
        this.agent.tools.getAll()
      );
      const llmDuration = Date.now() - llmStartTime;

      // 添加助手响应
      context.addAssistantMessage(response, callIndex);

      // 推送消息到 DebugHub
      this.pushToDebug(context.getAll());

      // 检查是否需要调用工具
      const hasToolCalls = response.toolCalls && response.toolCalls.length > 0;
      if (!hasToolCalls) {
        // 无工具调用：执行 StepFinish 钩子
        const stepFinishResult = await this.executeHookFn(
          'onStepFinished',
          () => this.onStepFinishedFn({
            step,
            callIndex,
            context,
            input,
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
          break;
        }

        // 处理反向钩子的决策
        if (stepFinishDecision === Decision.Deny) {
          completed = true;
          finalResponse = response.content;
          break;
        }

        // 如果反向钩子要求继续（Approve），不结束循环
        if (stepFinishDecision === Decision.Approve || stepFinishResult?.action === 'continue') {
          continue outerLoop;
        }

        // 真正结束
        return { completed: true, finalResponse: response.content, turns: step + 1 };
      }

      // 执行工具
      let waitCalled = false;
      for (const call of response.toolCalls) {
        if (call.name === 'wait') {
          waitCalled = true;
        }
        await this.executeToolFn(call, input, context, step, callIndex);
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
        break;
      }

      // 处理反向钩子的决策
      if (stepFinishDecision === Decision.Deny) {
        completed = true;
        finalResponse = response.content;
        break;
      }

      if (stepFinishDecision === Decision.Approve || stepFinishResult?.action === 'continue') {
        continue outerLoop;
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

    return {
      finalResponse,
      completed,
      turns: this.agent._currentStep + 1,
    };
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
