/**
 * ReAct 循环执行器
 *
 * 封装完整的 ReAct 循环逻辑
 */

import type { Context } from '../context.js';
import type { ToolRegistry } from '../tool.js';
import type { ToolCall, LLMResponse, Message } from '../types.js';
import type { ToolResult, HookResult } from '../lifecycle.js';
import type { ReActContext, ReActResult, DebugPusher } from './types.js';
import type { AgentFeature, ReActLoopHooks } from '../feature.js';

/**
 * ReAct 循环执行器类
 */
export class ReActLoopRunner {
  private reactLoopHooks?: ReActLoopHooks[];
  private subAgentFeature?: any; // SubAgentFeature reference for direct access

  constructor(
    private agent: {
      llm: any;
      tools: ToolRegistry;
      maxTurns: number;
      debugEnabled: boolean;
      agentId?: string;
      _currentTurn: number;
      _agentId?: string;
      _parentPool?: any;
      debugPusher?: DebugPusher;
      features?: Map<string, AgentFeature>;
    },
    private executeHookFn: (
      hookName: string,
      hookFn: () => Promise<any>,
      options: { input?: string; turn?: number }
    ) => Promise<any>,
    private executeToolFn: (
      call: ToolCall,
      input: string,
      context: Context,
      turn: number
    ) => Promise<void>,
    private onTurnStartFn: (ctx: any) => Promise<void>,
    private onLLMStartFn: (ctx: any) => Promise<HookResult | undefined>,
    private onLLMFinishFn: (ctx: any) => Promise<HookResult | undefined>,
    private onTurnFinishedFn: (ctx: any) => Promise<HookResult | undefined>,
    private onInterruptFn: (ctx: any) => Promise<void>
  ) {
    // 收集 ReAct 循环钩子（延迟收集，确保 features 已注册）
    this.collectHooks();
  }

  /**
   * 收集所有 Feature 的 ReAct 循环钩子
   */
  private collectHooks(): void {
    const hooks: ReActLoopHooks[] = [];

    // 从 agent.features 获取所有 Feature 的钩子
    const features = this.agent.features;

    if (features) {
      for (const feature of features.values()) {
        if (feature.getReActLoopHooks) {
          const hook = feature.getReActLoopHooks();
          if (hook) {
            hooks.push(hook);
            // 保存 SubAgentFeature 引用，用于直接访问 AgentPool
            if (feature.name === 'subagent') {
              this.subAgentFeature = feature;
            }
          }
        }
      }
    }

    this.reactLoopHooks = hooks;
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
  }): Promise<ReActResult> {
    const { isFirstCall } = options;

    // ========== ReAct 循环 ==========
    let completed = false;
    let finalResponse = '';

    outerLoop:
    for (let turn = 0; turn < this.agent.maxTurns; turn++) {
      this.agent._currentTurn = turn;

      // 推送消息到 DebugHub
      this.pushToDebug(context.getAll());

      // ========== Turn Start ==========
      await this.executeHookFn(
        'onTurnStart',
        () => this.onTurnStartFn({ turn, context, input }),
        { input, turn }
      );

      // ========== LLM Start ==========
      const llmStartResult = await this.executeHookFn(
        'onLLMStart',
        () => this.onLLMStartFn({
          messages: context.getAll(),
          tools: this.agent.tools.getAll(),
          turn,
        }),
        { input, turn }
      );

      // 检查是否被阻止
      if (llmStartResult?.action === 'block') {
        const blockResponse = llmStartResult.reason || 'LLM call blocked by hook';
        context.add({
          role: 'assistant',
          content: blockResponse,
        });

        completed = true;
        finalResponse = blockResponse;
        break;
      }

      // 执行 LLM 调用
      const llmStartTime = Date.now();
      const response = await this.agent.llm.chat(
        context.getAll(),
        this.agent.tools.getAll()
      );
      const llmDuration = Date.now() - llmStartTime;

      // ========== LLM Finish ==========
      const llmFinishResult = await this.executeHookFn(
        'onLLMFinish',
        () => this.onLLMFinishFn({ response, turn, duration: llmDuration, context }),
        { input, turn }
      );

      // 添加助手响应
      context.add({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
        reasoning: response.reasoning,
      });

      // 推送消息到 DebugHub
      this.pushToDebug(context.getAll());

      // 【新增】处理钩子返回的控制流指令
      if (llmFinishResult?.action === 'end') {
        completed = true;
        finalResponse = response.content;
        break;
      }

      // 检查是否需要调用工具
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // 【修改】如果钩子要求继续，不结束循环
        if (llmFinishResult?.action === 'continue') {
          continue outerLoop;
        }

        // 【保留】向后兼容：调用 ReActLoopHooks（标记废弃）
        const hookResult = await this.callBeforeNoToolCalls(context, response, turn);
        if (hookResult?.shouldEnd === false) {
          continue outerLoop;
        }

        // 真正结束
        await this.executeHookFn(
          'onTurnFinished',
          () => this.onTurnFinishedFn({
            turn,
            context,
            input,
            llmResponse: response,
            toolCallsCount: 0,
          }),
          { input, turn }
        );

        return { completed: true, finalResponse: response.content, turns: turn + 1 };
      }

      // 执行工具
      let waitCalled = false;
      for (const call of response.toolCalls) {
        if (call.name === 'wait') {
          waitCalled = true;
        }
        await this.executeToolFn(call, input, context, turn);
      }

      // 调用 Feature 钩子：afterToolCalls
      await this.callAfterToolCalls(context, response.toolCalls, turn);

      // 推送消息到 DebugHub
      this.pushToDebug(context.getAll());

      // wait 工具处理：如果有 wait 调用且有活跃子代理，等待消息后继续循环
      if (waitCalled) {
        const waitResult = await this.handleWait(context, turn);
        if (waitResult.shouldContinue) {
          continue;
        }
      }

      // 推送到 DebugHub
      this.pushToDebug(context.getAll());

      // ========== Turn Finished（有工具调用）==========
      const turnFinishResult = await this.executeHookFn(
        'onTurnFinished',
        () => this.onTurnFinishedFn({
          turn,
          context,
          input,
          llmResponse: response,
          toolCallsCount: response.toolCalls?.length ?? 0,
        }),
        { input, turn }
      );

      // 【新增】处理钩子返回的控制流指令
      if (turnFinishResult?.action === 'end') {
        completed = true;
        finalResponse = response.content;
        break;
      }
      if (turnFinishResult?.action === 'continue') {
        continue outerLoop;
      }
    }

    // 达到最大轮次 - 中断处理
    if (!completed) {
      const partialResult = context.getAll()[context.getAll().length - 1]?.content || '';

      // 触发中断钩子
      const interruptResult = await this.executeHookFn(
        'onInterrupt',
        () => this.onInterruptFn({
          reason: 'max_turns_reached',
          turn: this.agent._currentTurn,
          context,
        }),
        { input, turn: this.agent._currentTurn }
      );

      finalResponse = interruptResult as string ?? partialResult;

      // 调用 Feature 钩子：onMaxTurnsReached
      await this.callOnMaxTurnsReached(context, finalResponse, this.agent._currentTurn);
    }

    return {
      finalResponse,
      completed,
      turns: this.agent._currentTurn + 1,
    };
  }

  /**
   * 处理无工具调用的情况
   */
  private async handleNoToolCalls(
    response: LLMResponse,
    context: Context,
    input: string,
    turn: number
  ): Promise<{ completed: boolean; response: string }> {
    // 调用 Feature 钩子：beforeNoToolCalls
    const hookResult = await this.callBeforeNoToolCalls(context, response, turn);
    if (hookResult?.shouldEnd === false) {
      // Feature 要求不结束循环
      return { completed: false, response: '' };
    }

    // 无活跃子代理 - 真正结束
    await this.executeHookFn(
      'onTurnFinished',
      () => this.onTurnFinishedFn({
        turn,
        context,
        input,
        llmResponse: response,
        toolCallsCount: 0,
      }),
      { input, turn }
    );

    return { completed: true, response: response.content };
  }

  /**
   * 调用 Feature 钩子：afterToolCalls
   */
  private async callAfterToolCalls(context: Context, toolCalls: ToolCall[], turn: number): Promise<void> {
    if (!this.reactLoopHooks) return;

    for (const hook of this.reactLoopHooks) {
      if (hook.afterToolCalls) {
        await hook.afterToolCalls({ context, toolCalls, turn });
      }
    }
  }

  /**
   * 调用 Feature 钩子：beforeNoToolCalls
   */
  private async callBeforeNoToolCalls(
    context: Context,
    llmResponse: LLMResponse,
    turn: number
  ): Promise<{ shouldEnd?: boolean } | undefined> {
    if (!this.reactLoopHooks) return undefined;

    for (const hook of this.reactLoopHooks) {
      if (hook.beforeNoToolCalls) {
        const result = await hook.beforeNoToolCalls({ context, llmResponse, turn });
        if (result?.shouldEnd === false) {
          return result;
        }
      }
    }
    return undefined;
  }

  /**
   * 处理 wait 工具
   */
  private async handleWait(context: Context, turn: number): Promise<{ shouldContinue: boolean }> {
    if (!this.reactLoopHooks || !this.subAgentFeature) {
      return { shouldContinue: false };
    }

    // 检查是否应该等待
    for (const hook of this.reactLoopHooks) {
      if (hook.shouldWaitForSubAgent && await hook.shouldWaitForSubAgent({ waitCalled: true, context, turn })) {
        // Feature 确认需要等待，执行等待逻辑
        if (this.subAgentFeature.agentPool) {
          const result = await this.subAgentFeature.agentPool.waitForMessage();
          const timestamp = new Date().toISOString();
          console.log(`[DEBUG:主代理-wait调用] ${timestamp} 收到子代理消息 agentId=${result.agentId}, 插入到 context`);

          // 调用 afterWait 钩子
          if (hook.afterWait) {
            await hook.afterWait({ result, context, turn });
          }

          this.pushToDebug(context.getAll());
          return { shouldContinue: true }; // 继续下一轮
        }
      }
    }

    return { shouldContinue: false };
  }

  /**
   * 调用 Feature 钩子：onMaxTurnsReached
   */
  private async callOnMaxTurnsReached(context: Context, result: string, turn: number): Promise<void> {
    if (!this.reactLoopHooks) return;

    for (const hook of this.reactLoopHooks) {
      if (hook.onMaxTurnsReached) {
        await hook.onMaxTurnsReached({ context, result, turn, agentId: this.agent._agentId });
      }
    }
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
