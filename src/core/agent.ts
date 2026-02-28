/**
 * Agent - 组装所有组件
 * 提供简单的使用接口 - v4 重构版
 *
 * 重构说明：
 * - 钩子执行器移至 agent/hooks-executor.ts
 * - 生命周期钩子移至 agent/lifecycle-hooks.ts（使用 Mixin 模式）
 * - 模板解析器移至 agent/template-resolver.ts
 * - 工具执行器移至 agent/tool-executor.ts
 * - ReAct 循环移至 agent/react-loop.ts
 */

import type { AgentConfig, ToolCall, Tool, Message } from './types.js';
import type { AgentFeature, FeatureInitContext, FeatureContext, ContextInjector } from './feature.js';
import type { TemplateSource, PlaceholderContext } from '../template/types.js';
import { ToolRegistry } from './tool.js';
import { Context, ContextSnapshot } from './context.js';
import { DebugHub } from './debug-hub.js';
import type {
  ToolContext,
  ToolResult,
  HookResult,
  AgentInitiateContext,
  AgentDestroyContext,
  AgentInterruptContext,
  CallStartContext,
  CallFinishContext,
  TurnStartContext,
  TurnFinishedContext,
  LLMStartContext,
  LLMFinishContext,
  SubAgentSpawnContext,
  SubAgentUpdateContext,
  SubAgentDestroyContext,
  SubAgentInterruptContext,
} from './lifecycle.js';
import { TemplateComposer } from '../template/composer.js';
import { TemplateLoader } from '../template/loader.js';

// 导入重构后的模块
import { HookErrorHandling, executeHook } from './agent/hooks-executor.js';
import { type LifecycleHooks } from './agent/lifecycle-hooks.js';
import { TemplateResolver } from './agent/template-resolver.js';
import { ToolExecutor } from './agent/tool-executor.js';
import { ReActLoopRunner } from './agent/react-loop.js';
import type { DebugPusher } from './agent/types.js';

// Re-export ContextSnapshot and HookErrorHandling for convenience
export type { ContextSnapshot };
export { HookErrorHandling };

// 基础类（不含生命周期钩子）
class AgentBase {
  // ========== 属性 ==========

  protected llm: AgentConfig['llm'];
  protected tools: ToolRegistry;
  protected maxTurns: number;
  protected systemMessage?: string | TemplateSource;
  protected config: AgentConfig;
  protected templateLoader: TemplateLoader;
  protected persistentContext?: Context;
  protected debugHub?: DebugHub;
  protected agentId?: string;
  protected debugEnabled: boolean = false;

  // 子代理相关
  protected _agentId?: string;
  protected _parentPool?: any; // AgentPool reference from parent

  // Feature 系统
  private features = new Map<string, AgentFeature>();
  private contextInjectors: Array<{
    pattern: string | RegExp;
    injector: ContextInjector;
  }> = [];
  private featureToolsReady: boolean = false;
  private contextFeature?: import('./context-types.js').ContextFeature;

  // 生命周期状态
  protected _initialized: boolean = false;
  protected _currentCallInput?: string;
  protected _currentTurn: number = 0;  // ReAct 循环迭代号
  protected _callTurn: number = -1;     // 用户交互次数（onCall 次数）
  protected _callStartTimes: Map<number, number> = new Map();

  // 模块实例（延迟初始化）
  private templateResolver?: TemplateResolver;
  private toolExecutor?: ToolExecutor;
  private reactRunner?: ReActLoopRunner;

  constructor(config: AgentConfig) {
    this.config = config;
    this.llm = config.llm;
    this.maxTurns = config.maxTurns ?? 10;
    this.systemMessage = config.systemMessage;
    this.templateLoader = new TemplateLoader();
    this.tools = new ToolRegistry();

    // 如果 systemMessage 是 TemplateComposer，保存引用
    const templateComposer = config.systemMessage instanceof TemplateComposer
      ? config.systemMessage
      : undefined;

    // 初始化 TemplateResolver
    this.templateResolver = new TemplateResolver(
      this.systemMessage,
      undefined, // systemContext 将在 setSystemContext 中设置
      templateComposer,
      this.templateLoader,
      () => {
        // 回调：从 SkillFeature 获取 skills
        const skillFeature = this.features.get('skill') as any;
        return skillFeature?.getSkills ? skillFeature.getSkills() : [];
      }
    );

    // 注册工具
    if (config.tools) {
      for (const tool of config.tools) {
        this.tools.register(tool);
      }
    }
  }

  // ========== 钩子错误处理策略 ==========

  /**
   * 获取钩子的错误处理策略（可被子类覆盖）
   */
  public getHookErrorHandling(hookName: string): HookErrorHandling {
    const propagateHooks = [
      'onCallStart', 'onCallFinish',
      'onLLMStart', 'onLLMFinish',
      'onToolUse', 'onToolFinished',
    ];
    return propagateHooks.includes(hookName) ? HookErrorHandling.Propagate : HookErrorHandling.Silent;
  }

  // ========== 公开方法 ==========

  /**
   * 唯一的公开入口 - 执行 Agent
   */
  async onCall(input: string): Promise<string> {
    // 确保 Feature 工具已注册
    await this.ensureFeatureTools();

    // 设置通知上下文
    try {
      const { _setNotificationAgent } = await import('./notification.js');
      _setNotificationAgent(this.agentId!);
    } catch {
      // 通知模块不可用，忽略
    }

    // ========== Call Start ==========
    const context = this.persistentContext ?? new Context();
    const isFirstCall = !this._initialized;
    const callStartTime = Date.now();
    const callId = Date.now();

    // 递增 call turn（用户交互次数）
    this._callTurn++;

    this._currentCallInput = input;
    this._callStartTimes.set(callId, callStartTime);

    this._currentCallInput = input;
    this._callStartTimes.set(callId, callStartTime);

    // 触发 onCallStart
    await executeHook(
      this,
      () => (this as any).onCallStart({ input, context, isFirstCall }),
      { hookName: 'onCallStart', input }
    );

    try {
      // ========== Agent Initiate（仅首次）==========
      if (!this._initialized) {
        // 先触发 onInitiate
        await executeHook(
          this,
          () => (this as any).onInitiate({ context }),
          { hookName: 'onInitiate', input }
        );

        // 加载系统提示词
        if (this.templateResolver && context.getAll().length === 0) {
          const systemMsg = await this.templateResolver.resolve();
          if (systemMsg) {
            context.add({ role: 'system', content: systemMsg });
          }
        }

        // 添加用户输入
        context.add({ role: 'user', content: input });

        // 推送初始状态到 DebugHub
        this.pushToDebug(context.getAll());

        this._initialized = true;
      } else {
        // 非首次调用，直接添加用户输入
        context.add({ role: 'user', content: input });
        this.pushToDebug(context.getAll());
      }

      // ========== 初始化执行器（延迟初始化）==========
      this.ensureExecutorsInitialized();

      // ========== ReAct 循环 ==========
      const result = await this.reactRunner!.run(input, context, { isFirstCall, callTurn: this._callTurn });

      // 保存上下文
      this.persistentContext = context;

      // ========== Call Finish（成功）==========
      await executeHook(
        this,
        () => (this as any).onCallFinish({
          input,
          context,
          response: result.finalResponse,
          turns: result.turns,
          completed: result.completed,
        }),
        { hookName: 'onCallFinish', input }
      );

      return result.finalResponse;

    } catch (error) {
      // ========== Call Finish（异常）==========
      const errorMsg = error instanceof Error ? error.message : String(error);

      // 如果是子代理，报告错误中断给父代理
      if (this._agentId && this._parentPool) {
        const errorResult = `[执行出错: ${errorMsg}]`;
        await this._parentPool.handleInterrupt(
          this._agentId,
          'error',
          errorResult
        );
      }

      await executeHook(
        this,
        () => (this as any).onCallFinish({
          input,
          context,
          response: errorMsg,
          turns: this._currentTurn + 1,
          completed: false,
        }),
        { hookName: 'onCallFinish', input }
      );

      throw error;

    } finally {
      this._callStartTimes.delete(callId);
      this._currentCallInput = undefined;
      this._currentTurn = 0;

      // 清除通知上下文
      try {
        const { _clearNotificationAgent } = await import('./notification.js');
        _clearNotificationAgent();
      } catch {
        // 通知模块不可用，忽略
      }
    }
  }

  /**
   * 启用可视化查看器
   */
  async withViewer(name?: string, port?: number, openBrowser?: boolean): Promise<this> {
    this.debugHub = DebugHub.getInstance();
    this.debugEnabled = true;

    if (!this.debugHub.getCurrentAgentId()) {
      await this.debugHub.start(port, openBrowser);
    }

    // 确保 Feature 工具已注册（包括 SubAgentFeature 等提供的工具）
    await this.ensureFeatureTools();

    this.agentId = this.debugHub.registerAgent(this, name || this.constructor.name);
    this.debugHub.registerAgentTools(this.agentId, this.tools.getAll());

    return this;
  }

  /**
   * 设置上下文
   */
  withContext(context: Context): this {
    this.persistentContext = context;
    return this;
  }

  /**
   * 从快照加载上下文
   */
  load(snapshot: ContextSnapshot): this {
    this.persistentContext = Context.fromJSON(snapshot);
    return this;
  }

  /**
   * 保存上下文为快照
   */
  save(): ContextSnapshot | undefined {
    return this.persistentContext?.toJSON();
  }

  /**
   * 重置上下文
   */
  reset(): this {
    this.persistentContext = undefined;
    return this;
  }

  // ========== 模板系统 API ==========

  /**
   * 设置系统提示词模板
   */
  setSystemPrompt(prompt: string | TemplateSource): this {
    this.templateResolver?.setSystemMessage(prompt);
    return this;
  }

  /**
   * 设置占位符上下文变量
   */
  setSystemContext(context: PlaceholderContext): this {
    this.templateResolver?.setSystemContext(context);
    return this;
  }

  // ========== 向后兼容 API ==========

  /**
   * 获取上下文（用于调试，向后兼容）
   */
  getContext(): Context {
    return this.persistentContext ?? new Context();
  }

  /**
   * 获取工具列表（向后兼容）
   */
  getTools(): ToolRegistry {
    return this.tools;
  }

  // ========== 子代理管理 ==========

  /**
   * 子代理向父代理回传消息
   */
  protected async reportToParent(message: string): Promise<void> {
    if (!this._parentPool || !this._agentId) {
      return;
    }
    await this._parentPool.report(this._agentId, message);
  }

  /**
   * 创建 Agent 实例（子类可覆盖）
   */
  public async createAgentByType(type: string): Promise<AgentBase> {
    switch (type) {
      case 'ExplorerAgent': {
        const { ExplorerAgent } = await import('../agents/system/ExplorerAgent.js');
        return new ExplorerAgent({
          llm: this.llm,
        });
      }
      case 'BasicAgent':
      default: {
        const { BasicAgent } = await import('../agents/system/BasicAgent.js');
        return new BasicAgent({
          llm: this.llm,
          tools: this.tools.getAll().slice(0, 3),
        });
      }
    }
  }

  // ========== 清理 ==========

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    // 触发 onDestroy 钩子（SubAgentFeature 的清理会在 Feature.onDestroy 中处理）
    const context = this.persistentContext ?? new Context();

    try {
      await executeHook(
        this,
        () => (this as any).onDestroy({ context }),
        { hookName: 'onDestroy' }
      );
    } catch (error) {
      console.warn('[Agent] onDestroy hook error:', error);
    }

    // 清理 Features
    for (const feature of this.features.values()) {
      if (feature.onDestroy) {
        try {
          await feature.onDestroy({ agentId: this.agentId || '', config: this.config });
        } catch (error) {
          console.warn(`[Agent] Feature ${feature.name} cleanup error:`, error);
        }
      }
    }

    // 注销 DebugHub
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.unregisterAgent(this.agentId);
    }

    // 重置状态
    this._initialized = false;
    this.persistentContext = undefined;
  }

  // ========== Feature 系统 ==========

  /**
   * 使用 Feature（链式调用）
   */
  use(feature: AgentFeature): this {
    this.features.set(feature.name, feature);

    // 如果是 SubAgentFeature，设置父代理引用
    if (feature.name === 'subagent' && (feature as any)._setParentAgent) {
      (feature as any)._setParentAgent(this);
    }

    // 如果是 ContextFeature，保存引用
    if (feature.name === 'context') {
      this.contextFeature = feature as import('./context-types.js').ContextFeature;
    }

    if (feature.getContextInjectors) {
      for (const [pattern, injector] of feature.getContextInjectors()) {
        this.contextInjectors.push({ pattern, injector });
      }
    }

    return this;
  }

  /**
   * 启用 Feature 的所有工具
   *
   * @example
   * agent.enable('mcp')  // 启用 MCP 工具
   */
  enable(featureName: string): this {
    const feature = this.features.get(featureName);
    if (!feature) {
      console.warn(`[Agent] Feature '${featureName}' 不存在`);
      return this;
    }

    const tools = feature.getTools?.() ?? [];
    let count = 0;
    for (const tool of tools) {
      if (this.tools.enable(tool.name)) {
        count++;
      }
    }

    if (count > 0) {
      console.log(`[Agent] 已启用 Feature '${featureName}' 的 ${count} 个工具`);
    }

    return this;
  }

  /**
   * 禁用 Feature 的所有工具
   *
   * @example
   * agent.disable('mcp')  // 禁用 MCP 工具
   */
  disable(featureName: string): this {
    const feature = this.features.get(featureName);
    if (!feature) {
      console.warn(`[Agent] Feature '${featureName}' 不存在`);
      return this;
    }

    const tools = feature.getTools?.() ?? [];
    let count = 0;
    for (const tool of tools) {
      if (this.tools.disable(tool.name)) {
        count++;
      }
    }

    if (count > 0) {
      console.log(`[Agent] 已禁用 Feature '${featureName}' 的 ${count} 个工具`);
    }

    return this;
  }

  /**
   * 检查 Feature 是否启用
   *
   * @example
   * if (agent.isEnabled('mcp')) { ... }
   */
  isEnabled(featureName: string): boolean {
    const feature = this.features.get(featureName);
    if (!feature) return false;

    const tools = feature.getTools?.() ?? [];
    if (tools.length === 0) return true; // 空工具视为启用

    return tools.every(t => this.tools.isEnabled(t.name));
  }

  /**
   * 确保 Feature 工具已注册
   */
  private async ensureFeatureTools(): Promise<void> {
    if (this.featureToolsReady) return;

    for (const [name, feature] of this.features) {
      // 为每个 Feature 创建独立的 initContext
      const initContext: FeatureInitContext = {
        agentId: this.agentId || '',
        config: this.config,
        featureConfig: this.config.features?.[name],
        getFeature: <T extends AgentFeature>(featureName: string): T | undefined => {
          return this.features.get(featureName) as T | undefined;
        },
        registerTool: (tool) => this.tools.register(tool, name),
        getContextFeature: () => this.contextFeature,
      };

      if (feature.getTools) {
        for (const tool of feature.getTools()) {
          this.tools.register(tool, name);  // 传递来源
        }
      }

      if (feature.getAsyncTools) {
        try {
          const tools = await feature.getAsyncTools(initContext);
          for (const tool of tools) {
            this.tools.register(tool, name);  // 传递来源
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`[Agent] Feature ${name} failed to load tools: ${errorMsg}`);
        }
      }

      if (feature.onInitiate) {
        try {
          await feature.onInitiate(initContext);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`[Agent] Feature ${name} onInitiate failed: ${errorMsg}`);
        }
      }
    }

    this.featureToolsReady = true;
  }

  // ========== 内部方法 ==========

  /**
   * 确保执行器已初始化（延迟初始化）
   */
  private ensureExecutorsInitialized(): void {
    if (this.toolExecutor && this.reactRunner) return;

    // Debug 推送接口
    const debugPusher: DebugPusher = {
      pushMessages: (agentId: string, messages: Message[]) => {
        if (this.debugHub) {
          this.debugHub.pushMessages(agentId, messages);
        }
      },
    };

    // 初始化 ToolExecutor
    this.toolExecutor = new ToolExecutor(
      this.tools,
      this.contextInjectors,
      this,
      (hookName, hookFn, options) => executeHook(this, hookFn, { hookName, ...options }),
      (ctx) => (this as any).onToolUse(ctx),
      (result) => (this as any).onToolFinished(result),
      this.contextFeature
    );

    // 初始化 ReActLoopRunner
    this.reactRunner = new ReActLoopRunner(
      {
        llm: this.llm,
        tools: this.tools,
        maxTurns: this.maxTurns,
        debugEnabled: this.debugEnabled,
        agentId: this.agentId,
        _currentTurn: this._currentTurn,
        _agentId: this._agentId,
        _parentPool: this._parentPool,
        debugPusher,
        features: this.features,
      },
      (hookName, hookFn, options) => executeHook(this, hookFn, { hookName, ...options }),
      (call, input, context, turn, callTurn) => this.toolExecutor!.execute(call, input, context, turn, callTurn),
      (ctx) => (this as any).onTurnStart(ctx),
      (ctx) => (this as any).onLLMStart(ctx),
      (ctx) => (this as any).onLLMFinish(ctx),
      (ctx) => (this as any).onTurnFinished(ctx),
      (ctx) => (this as any).onInterrupt(ctx)
    );
  }

  /**
   * 推送到 DebugHub
   */
  private pushToDebug(messages: Message[]): void {
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.pushMessages(this.agentId, messages);
    }
  }

  // ========== 生命周期钩子（扩展返回值）==========

  // Agent/Call 级：保持 void
  protected async onInitiate(_ctx: AgentInitiateContext): Promise<void> {}
  protected async onDestroy(_ctx: AgentDestroyContext): Promise<void> {}
  protected async onCallStart(_ctx: CallStartContext): Promise<void> {}
  protected async onCallFinish(_ctx: CallFinishContext): Promise<void> {}
  protected async onTurnStart(_ctx: TurnStartContext): Promise<void> {}

  // LLM/Turn 级：扩展返回 HookResult
  protected async onLLMStart(_ctx: LLMStartContext): Promise<HookResult | undefined> {
    return undefined;
  }

  /**
   * LLM 调用完成钩子（扩展支持流控制）
   *
   * @returns
   * - undefined: 默认行为
   * - { action: 'continue' }: 继续循环（即使无 toolCalls 也不结束）
   * - { action: 'end' }: 强制结束循环
   */
  protected async onLLMFinish(_ctx: LLMFinishContext): Promise<HookResult | undefined> {
    // 【新增】默认实现：自动对接 SubAgentFeature
    const subAgent = this.features.get('subagent') as any;
    const hasToolCalls = _ctx.response.toolCalls && _ctx.response.toolCalls.length > 0;

    if (!hasToolCalls && subAgent?.handleNoToolCalls) {
      return subAgent.handleNoToolCalls(_ctx.context);
    }
    return undefined;
  }

  /**
   * Turn 结束钩子（扩展支持流控制）
   *
   * @returns
   * - undefined: 默认行为
   * - { action: 'continue' }: 继续下一轮
   * - { action: 'end' }: 强制结束循环
   */
  protected async onTurnFinished(_ctx: TurnFinishedContext): Promise<HookResult | undefined> {
    // 【新增】默认实现：自动对接 SubAgentFeature
    const subAgent = this.features.get('subagent') as any;
    const hasWait = _ctx.llmResponse.toolCalls?.some(c => c.name === 'wait');

    if (hasWait && subAgent?.handleWait) {
      return subAgent.handleWait(_ctx.context);
    }
    return undefined;
  }

  protected async onToolUse(_ctx: ToolContext): Promise<HookResult | undefined> {
    return undefined;
  }

  /**
   * 工具执行完成钩子
   *
   * 【新增】默认实现：自动对接 SubAgentFeature
   */
  protected async onToolFinished(_result: ToolResult): Promise<void> {
    // 【新增】默认实现：自动对接 SubAgentFeature
    const subAgent = this.features.get('subagent') as any;
    await subAgent?.consumeMessages?.(_result.context);
  }

  // SubAgent 钩子
  public async onSubAgentSpawn(_ctx: SubAgentSpawnContext): Promise<void> {}
  public async onSubAgentUpdate(_ctx: SubAgentUpdateContext): Promise<void> {}
  public async onSubAgentDestroy(_ctx: SubAgentDestroyContext): Promise<void> {}
  public async onSubAgentInterrupt(_ctx: SubAgentInterruptContext): Promise<void> {}

  // 中断钩子
  protected async onInterrupt(ctx: AgentInterruptContext): Promise<string> {
    return `[执行被中断: ${ctx.reason}]`;
  }
}

// 导出 Agent 类
export { AgentBase as Agent };

