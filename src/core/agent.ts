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

import type { AgentConfig, ToolCall, Tool, Message, HookInspectorSnapshot, UsageInfo, AgentOverviewSnapshot } from './types.js';
import type { AgentFeature, FeatureInitContext, FeatureContext, ContextInjector } from './feature.js';
import type { TemplateSource, PlaceholderContext } from '../template/types.js';
import { ToolRegistry } from './tool.js';
import { Context, ContextSnapshot } from './context.js';
import { DebugHub } from './debug-hub.js';
import { createLogger, installConsoleBridge, runWithLogScope } from './logging.js';
import { captureFeatureSnapshots, restoreFeatureSnapshots } from './checkpoint.js';
import { getDefaultSessionStore, type AgentRuntimeSnapshot, type AgentSessionSnapshot, type SessionStore, type CallRollbackSnapshot } from './session-store.js';
import { UsageStats, type UsageStatsSnapshot } from './usage.js';
import type {
  ToolContext,
  ToolResult,
  HookResult,
  AgentInitiateContext,
  AgentDestroyContext,
  AgentInterruptContext,
  CallStartContext,
  CallFinishContext,
  StepStartContext,
  StepFinishedContext,
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

// 导入钩子注册表
import { HooksRegistry, type HookExecutionResult } from './hooks-registry.js';
import { CoreLifecycle, Decision } from './lifecycle.js';

// Re-export ContextSnapshot and HookErrorHandling for convenience
export type { ContextSnapshot };
export { HookErrorHandling };
export type { AgentSessionSnapshot, SessionStore };

type CallRollbackCheckpoint = CallRollbackSnapshot;

// 基础类（不含生命周期钩子）
class AgentBase {
  protected readonly logger = createLogger('agent.runtime');
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

  // 反向钩子注册表
  private hooksRegistry = new HooksRegistry();

  // 生命周期状态
  protected _initialized: boolean = false;
  protected _currentCallInput?: string;
  protected _currentStep: number = 0;   // ReAct 循环步骤序号
  protected _callIndex: number = -1;     // 用户交互序号（onCall 次数）
  protected _callStartTimes: Map<number, number> = new Map();
  protected _callCheckpoints: CallRollbackCheckpoint[] = [];

  // 用量统计
  protected usageStats: UsageStats = new UsageStats();

  // 用户输入缓存（用于 Feature 修改待注入的输入内容）
  private _pendingInput: string | null = null;

  // 模块实例（延迟初始化）
  private templateResolver?: TemplateResolver;
  private toolExecutor?: ToolExecutor;
  private reactRunner?: ReActLoopRunner;

  constructor(config: AgentConfig) {
    installConsoleBridge();
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
   * 设置待注入的用户输入
   *
   * Feature 可以在 CallStart 钩子中调用此方法来修改即将注入到上下文的输入内容
   * 典型用法：处理斜杠命令，去除命令前缀后更新输入
   *
   * @param input 新的输入内容
   */
  setUserInput(input: string): void {
    this._pendingInput = input;
  }

  /**
   * 获取当前待注入的用户输入
   *
   * Feature 可以在 CallStart 钩子中调用此方法来获取当前输入缓存
   * 用于链式处理或条件判断
   *
   * @returns 当前输入缓存，如果未设置则返回空字符串
   */
  getUserInput(): string {
    return this._pendingInput ?? '';
  }

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
    const nextCallIndex = this._callIndex + 1;
    const isFirstCall = nextCallIndex === 0;
    const callStartTime = Date.now();
    const callId = Date.now();

    // 递增 callIndex（用户交互序号）
    this._callIndex = nextCallIndex;

    this._currentCallInput = input;
    this._callStartTimes.set(callId, callStartTime);

    const agentName = this.config.name || this.constructor.name;

    return await runWithLogScope({
      agentId: this.agentId,
      agentName,
      callIndex: this._callIndex,
      tags: ['agent-call'],
      namespace: 'agent.call',
    }, async () => {
      this.logger.info('Call started', {
        isFirstCall,
        inputPreview: input.slice(0, 160),
      });

      // 触发 onCallStart（正向钩子）
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
        this.syncRegisteredToolsToDebug();
        this.pushInspectorSnapshot();

        // 加载系统提示词（必须在反向钩子之前，确保 context 为空）
        if (this.templateResolver && context.getAll().length === 0) {
          const systemMsg = await this.templateResolver.resolve();
          if (systemMsg) {
            context.addSystemMessage(systemMsg, this._callIndex);
          }
        }

        this._initialized = true;
      }

      const preCallRuntime = await this.captureRuntimeSnapshot(context, this._callIndex - 1);

      // ========== CallStart 反向钩子 ==========
      // 在系统提示词之后、用户输入之前调用，确保 Feature 可以正确注入消息

      // 设置输入缓存（Feature 可以在钩子中通过 setUserInput 修改）
      this._pendingInput = input;

      // 执行反向钩子，Feature 可以在此期间修改 _pendingInput
      await this.hooksRegistry.executeVoid(CoreLifecycle.CallStart, { input, context, isFirstCall, agent: this });
      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();

      // 添加用户输入（使用可能被 Feature 修改过的缓存）
      const finalInput = this._pendingInput ?? input;
      context.addUserMessage(finalInput, this._callIndex);
      this.pushToDebug(context.getAll());

      // ========== 初始化执行器（延迟初始化）==========
      this.ensureExecutorsInitialized();

      // ========== ReAct 循环 ==========
      const result = await this.reactRunner!.run(input, context, { isFirstCall, callIndex: this._callIndex });

      // 保存上下文
      this.persistentContext = context;
      this.commitCallCheckpoint({
        callIndex: this._callIndex,
        draftInput: finalInput,
        runtime: preCallRuntime,
      });

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

      // ========== CallFinish 反向钩子 ==========
      await this.hooksRegistry.executeVoid(CoreLifecycle.CallFinish, {
        input,
        context,
        response: result.finalResponse,
        steps: result.turns,
        completed: result.completed,
      });

        this.logger.info('Call completed', {
          completed: result.completed,
          turns: result.turns,
          durationMs: Date.now() - callStartTime,
        });
        return result.finalResponse;

      } catch (error) {
      // ========== Call Finish（异常）==========
      const errorMsg = error instanceof Error ? error.message : String(error);

      // 保留异常发生后最新的上下文状态。
      // 如果 step-level rollback 已触发，这里保存的就是回滚后的上下文。
      this.persistentContext = context;

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
          turns: this._currentStep + 1,
          completed: false,
        }),
        { hookName: 'onCallFinish', input }
      );

      // ========== CallFinish 反向钩子（异常）==========
      await this.hooksRegistry.executeVoid(CoreLifecycle.CallFinish, {
        input,
        context,
        response: errorMsg,
        steps: this._currentStep + 1,
        completed: false,
      });

        this.logger.error('Call failed', {
          error: errorMsg,
          durationMs: Date.now() - callStartTime,
        });
        throw error;

      } finally {
        this._callStartTimes.delete(callId);
        this._currentCallInput = undefined;
        this._currentStep = 0;

        // 清理输入缓存
        this._pendingInput = null;

        // 清除通知上下文
        try {
          const { _clearNotificationAgent } = await import('./notification.js');
          _clearNotificationAgent();
        } catch {
          // 通知模块不可用，忽略
        }
      }
    });
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

    // 收集 Feature 模板信息（使用新的统一方式）
    const featureTemplates: Record<string, string> = {};

    for (const feature of this.features.values()) {
      // 使用 getPackageInfo() + getTemplateNames() 方式
      if (feature.getPackageInfo && feature.getTemplateNames) {
        const pkgInfo = feature.getPackageInfo();
        const templateNames = feature.getTemplateNames();

        if (pkgInfo && templateNames.length > 0) {
          for (const templateName of templateNames) {
            // 构建统一的 URL 格式
            // 独立 npm 包（@agentdev/*）不包含 feature.name，因为一个包只有一个 feature
            // 内置 feature 使用 /template/{packageName}/{featureName}/{templateName}.render.js
            const isStandalonePackage = pkgInfo.name.startsWith('@agentdev/') && pkgInfo.name !== 'agentdev';
            const url = isStandalonePackage
              ? `/template/${pkgInfo.name}/${templateName}.render.js`
              : `/template/${pkgInfo.name}/${feature.name}/${templateName}.render.js`;
            featureTemplates[templateName] = url;
          }
        }
      }
    }

    this.agentId = this.debugHub.registerAgent(
      this,
      name || this.constructor.name,
      featureTemplates,
      this.buildHookInspectorSnapshot(),
      this.buildOverviewSnapshot()
    );
    this.syncRegisteredToolsToDebug();
    this.pushInspectorSnapshot();
    if (this.persistentContext) {
      this.pushToDebug(this.persistentContext.getAll());
    }

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
   * 生成当前会话快照
   */
  async createSessionSnapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    await this.ensureFeatureTools();
    const runtime = await this.captureRuntimeSnapshot(this.persistentContext, this._callIndex);

    return {
      version: 1,
      sessionId,
      savedAt: Date.now(),
      agentType: this.constructor.name,
      runtime,
      rollbackHistory: this._callCheckpoints.map(entry => ({
        callIndex: entry.callIndex,
        draftInput: entry.draftInput,
        runtime: { ...entry.runtime },
      })),
    };
  }

  /**
   * 从会话快照恢复
   */
  async restoreSessionSnapshot(snapshot: AgentSessionSnapshot): Promise<this> {
    await this.ensureFeatureTools();
    const normalized = this.normalizeSessionSnapshot(snapshot as AgentSessionSnapshot & Record<string, unknown>);
    await this.restoreRuntimeSnapshot(normalized.runtime);
    this._callCheckpoints = normalized.rollbackHistory.map(entry => ({
      callIndex: entry.callIndex,
      draftInput: entry.draftInput,
      runtime: entry.runtime,
    }));

    return this;
  }

  async rollbackToCall(callIndex: number): Promise<{ draftInput: string }> {
    await this.ensureFeatureTools();
    const checkpoint = this._callCheckpoints.find(entry => entry.callIndex === callIndex);
    if (!checkpoint) {
      throw new Error(`Rollback checkpoint for call ${callIndex} not found`);
    }

    await this.restoreRuntimeSnapshot(checkpoint.runtime);
    this._callCheckpoints = this._callCheckpoints.filter(entry => entry.callIndex < callIndex);
    this.pushToDebug(this.getContext().getAll());
    this.pushInspectorSnapshot();

    return { draftInput: checkpoint.draftInput };
  }

  /**
   * 保存会话到持久化存储
   */
  async saveSession(sessionId: string, store: SessionStore = getDefaultSessionStore()): Promise<string> {
    const snapshot = await this.createSessionSnapshot(sessionId);
    return store.save(sessionId, snapshot);
  }

  /**
   * 从持久化存储加载会话
   */
  async loadSession(sessionId: string, store: SessionStore = getDefaultSessionStore()): Promise<this> {
    const snapshot = await store.load(sessionId);
    return this.restoreSessionSnapshot(snapshot);
  }

  /**
   * 重置上下文
   */
  reset(): this {
    this.persistentContext = undefined;
    this._callCheckpoints = [];
    this._callIndex = -1;
    this._currentStep = 0;
    this._initialized = false;
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

  // ========== 用量统计 ==========

  /**
   * 获取用量统计
   */
  getUsage(): UsageStats {
    return this.usageStats;
  }

  /**
   * 记录一次 LLM 调用的用量
   * @param callIndex Call 序号
   * @param step Step 序号
   * @param usage 用量数据
   */
  recordUsage(callIndex: number, step: number, usage: UsageInfo): void {
    this.usageStats.record(callIndex, step, usage);
    this.pushOverviewSnapshot();
  }

  /**
   * 标记 Call 结束
   * @param callIndex Call 序号
   */
  endCallUsage(callIndex: number): void {
    this.usageStats.endCall(callIndex);
    this.pushOverviewSnapshot();
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
    this._callCheckpoints = [];
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
      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();
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
      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();
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
      const featureLogger = createLogger(`feature.${name}`, {
        agentId: this.agentId,
        agentName: this.config.name || this.constructor.name,
        feature: name,
        tags: [`feature:${name}`],
      });

      // 为每个 Feature 创建独立的 initContext
      const initContext: FeatureInitContext = {
        agentId: this.agentId || '',
        config: this.config,
        logger: featureLogger,
        featureConfig: this.config.features?.[name],
        getFeature: <T extends AgentFeature>(featureName: string): T | undefined => {
          return this.features.get(featureName) as T | undefined;
        },
        registerTool: (tool) => this.tools.register(tool, name),
      };

      if (feature.getTools) {
        for (const tool of runWithLogScope({ feature: name, namespace: `feature.${name}`, tags: [`feature:${name}`] }, () => feature.getTools!()) || []) {
          this.tools.register(tool, name);  // 传递来源
        }
      }

      if (feature.getAsyncTools) {
        try {
          const tools = await runWithLogScope({
            feature: name,
            namespace: `feature.${name}`,
            tags: [`feature:${name}`],
          }, () => feature.getAsyncTools!(initContext));
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
          await runWithLogScope({
            feature: name,
            namespace: `feature.${name}`,
            tags: [`feature:${name}`],
          }, () => feature.onInitiate!(initContext));
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`[Agent] Feature ${name} onInitiate failed: ${errorMsg}`);
        }
      }

      // 收集反向钩子
      this.hooksRegistry.collectFromFeature(feature);
    }

    this.featureToolsReady = true;
    this.pushInspectorSnapshot();
  }

  // ========== 内部方法 ==========

  /**
   * 解析相对路径（处理 ./ 和 ../）
   * @param baseDir 基础目录
   * @param relativePath 相对路径
   * @returns 绝对路径
   */
  private resolveRelativePath(baseDir: string, relativePath: string): string {
    // 规范化路径（统一使用 / 分隔符）
    const normalizedBase = baseDir.replace(/\\/g, '/');
    const normalizedRelative = relativePath.replace(/\\/g, '/');
    
    // 分割路径
    const baseParts = normalizedBase.split('/').filter(p => p.length > 0);
    const relativeParts = normalizedRelative.split('/');
    
    // 处理每个部分
    for (const part of relativeParts) {
      if (part === '.') {
        // 当前目录，忽略
        continue;
      } else if (part === '..') {
        // 上级目录
        if (baseParts.length > 0) {
          baseParts.pop();
        }
      } else {
        baseParts.push(part);
      }
    }
    
    // 重建路径
    const result = '/' + baseParts.join('/');
    return result;
  }

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
      this.hooksRegistry
    );

    // 初始化 ReActLoopRunner
    this.reactRunner = new ReActLoopRunner(
      {
        llm: this.llm,
        tools: this.tools,
        maxTurns: this.maxTurns,
        debugEnabled: this.debugEnabled,
        agentId: this.agentId,
        _currentStep: this._currentStep,
        _agentId: this._agentId,
        _parentPool: this._parentPool,
        debugPusher,
        features: this.features,
        hooksRegistry: this.hooksRegistry,
        recordUsage: (callIndex: number, step: number, usage: UsageInfo) => this.recordUsage(callIndex, step, usage),
        endCallUsage: (callIndex: number) => this.endCallUsage(callIndex),
      },
      (hookName, hookFn, options) => executeHook(this, hookFn, { hookName, ...options }),
      (call, input, context, step, callIndex) => this.toolExecutor!.execute(call, input, context, step, callIndex),
      (ctx) => (this as any).onStepStart(ctx),
      (ctx) => (this as any).onStepFinished(ctx),
      (ctx) => (this as any).onInterrupt(ctx)
    );
  }

  /**
   * 推送到 DebugHub
   */
  private pushToDebug(messages: Message[]): void {
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.pushMessages(this.agentId, messages);
      this.debugHub.updateAgentOverview(this.agentId, this.buildOverviewSnapshot());
    }
  }

  private pushOverviewSnapshot(): void {
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.updateAgentOverview(this.agentId, this.buildOverviewSnapshot());
    }
  }

  private async captureRuntimeSnapshot(context?: Context, callIndexOverride?: number): Promise<AgentRuntimeSnapshot> {
    await this.ensureFeatureTools();
    return {
      initialized: this._initialized,
      callIndex: callIndexOverride ?? this._callIndex,
      context: context?.toJSON(),
      featureStates: captureFeatureSnapshots(this.features),
      usageStats: this.usageStats.toSnapshot(),
    };
  }

  private async restoreRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): Promise<void> {
    if (snapshot.context) {
      this.persistentContext = Context.fromJSON(snapshot.context);
    } else {
      this.persistentContext = undefined;
    }
    await restoreFeatureSnapshots(snapshot.featureStates, this.features);
    this._initialized = snapshot.initialized;
    this._callIndex = snapshot.callIndex;
    this._currentStep = 0;

    // 恢复用量统计
    if (snapshot.usageStats) {
      this.usageStats.fromSnapshot(snapshot.usageStats);
    }
  }

  private commitCallCheckpoint(checkpoint: CallRollbackCheckpoint): void {
    this._callCheckpoints = this._callCheckpoints
      .filter(entry => entry.callIndex < checkpoint.callIndex)
      .concat(checkpoint);
  }

  private normalizeSessionSnapshot(snapshot: AgentSessionSnapshot & Record<string, unknown>): AgentSessionSnapshot {
    if ('runtime' in snapshot && snapshot.runtime) {
      return snapshot;
    }

    const legacyContext = snapshot.context as ContextSnapshot | undefined;
    const legacyFeatureStates = Array.isArray(snapshot.featureStates) ? snapshot.featureStates : [];
    const legacyCallIndex = typeof snapshot.callIndex === 'number' ? snapshot.callIndex : -1;

    return {
      version: typeof snapshot.version === 'number' ? snapshot.version : 1,
      sessionId: typeof snapshot.sessionId === 'string' ? snapshot.sessionId : 'legacy-session',
      savedAt: typeof snapshot.savedAt === 'number' ? snapshot.savedAt : Date.now(),
      agentType: typeof snapshot.agentType === 'string' ? snapshot.agentType : this.constructor.name,
      runtime: {
        initialized: Boolean(snapshot.initialized),
        callIndex: legacyCallIndex,
        context: legacyContext,
        featureStates: legacyFeatureStates,
      },
      rollbackHistory: [],
    };
  }

  private syncRegisteredToolsToDebug(): void {
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.registerAgentTools(this.agentId, this.tools.getAll());
    }
  }

  private pushInspectorSnapshot(): void {
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.updateAgentInspector(this.agentId, this.buildHookInspectorSnapshot());
    }
  }

  private buildOverviewSnapshot(): AgentOverviewSnapshot {
    const messages = this.getContext().getAll();
    const contextChars = messages.reduce((sum, message) => {
      const contentLength = typeof message.content === 'string' ? message.content.length : 0;
      const reasoningLength = typeof message.reasoning === 'string' ? message.reasoning.length : 0;
      const thinkingLength = Array.isArray(message.thinkingBlocks)
        ? message.thinkingBlocks.reduce((blockSum, block) => blockSum + (block.thinking?.length || 0), 0)
        : 0;
      const toolCallLength = Array.isArray(message.toolCalls)
        ? JSON.stringify(message.toolCalls).length
        : 0;
      return sum + contentLength + reasoningLength + thinkingLength + toolCallLength;
    }, 0);

    const toolCallCount = messages.reduce((sum, message) => sum + (message.toolCalls?.length || 0), 0);
    const turnCount = messages.reduce((maxTurn, message) => Math.max(maxTurn, typeof message.turn === 'number' ? message.turn + 1 : maxTurn), 0);

    return {
      updatedAt: Date.now(),
      context: {
        messageCount: messages.length,
        charCount: contextChars,
        toolCallCount,
        turnCount,
      },
      usageStats: this.usageStats.toSnapshot(),
    };
  }

  private buildHookInspectorSnapshot(): HookInspectorSnapshot {
    const hookGroups = this.hooksRegistry.getSnapshot();
    const hookCountByFeature = new Map<string, number>();
    const toolEntriesByFeature = new Map<string, Array<{
      name: string;
      description: string;
      enabled: boolean;
      renderCall?: string;
      renderResult?: string;
    }>>();

    const summarizeToolDescription = (description: string | undefined): string => {
      if (!description) return '';
      const normalized = description
        .replace(/\r\n/g, '\n')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalized) return '';
      return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
    };

    for (const group of hookGroups) {
      for (const entry of group.entries) {
        hookCountByFeature.set(entry.featureName, (hookCountByFeature.get(entry.featureName) || 0) + 1);
      }
    }

    for (const entry of this.tools.getEntries()) {
      if (!entry.source) continue;
      if (!toolEntriesByFeature.has(entry.source)) {
        toolEntriesByFeature.set(entry.source, []);
      }

      const renderCall = typeof entry.tool.render?.call === 'string'
        ? entry.tool.render.call
        : entry.tool.render?.call
          ? 'inline'
          : undefined;
      const renderResult = typeof entry.tool.render?.result === 'string'
        ? entry.tool.render.result
        : entry.tool.render?.result
          ? 'inline'
          : undefined;

      toolEntriesByFeature.get(entry.source)!.push({
        name: entry.tool.name,
        description: summarizeToolDescription(entry.tool.description),
        enabled: entry.enabled,
        renderCall,
        renderResult,
      });
    }

    const features = Array.from(this.features.values()).map(feature => {
      const tools = toolEntriesByFeature.get(feature.name) || [];
      const enabledToolCount = tools.filter(tool => tool.enabled).length;
      const status: 'enabled' | 'disabled' | 'partial' = tools.length === 0
        ? 'enabled'
        : enabledToolCount === 0
          ? 'disabled'
          : enabledToolCount === tools.length
            ? 'enabled'
            : 'partial';

      return {
        name: feature.name,
        enabled: status === 'enabled',
        status,
        hookCount: hookCountByFeature.get(feature.name) || 0,
        toolCount: tools.length,
        enabledToolCount,
        source: typeof (feature as any).source === 'string'
          ? (feature as any).source
          : hookGroups.flatMap(group => group.entries)
              .find(entry => entry.featureName === feature.name)?.source?.file,
        description: typeof (feature as any).description === 'string'
          ? (feature as any).description
          : undefined,
        tools,
      };
    });

    return {
      lifecycleOrder: hookGroups.map(group => group.lifecycle),
      features,
      hooks: hookGroups,
    };
  }

  // ========== 生命周期钩子（扩展返回值）==========

  // Agent/Call 级：保持 void
  protected async onInitiate(_ctx: AgentInitiateContext): Promise<void> {}
  protected async onDestroy(_ctx: AgentDestroyContext): Promise<void> {}
  protected async onCallStart(_ctx: CallStartContext): Promise<void> {}
  protected async onCallFinish(_ctx: CallFinishContext): Promise<void> {}
  protected async onStepStart(_ctx: StepStartContext): Promise<void> {}

  /**
   * Step 结束钩子（扩展支持流控制）
   *
   * @returns
   * - undefined: 默认行为
   * - { action: 'continue' }: 继续下一步
   * - { action: 'end' }: 强制结束循环
   */
  protected async onStepFinished(_ctx: StepFinishedContext): Promise<HookResult | undefined> {
    // 移除硬编码依赖：反向钩子通过 HooksRegistry 执行
    return undefined;
  }

  protected async onToolUse(_ctx: ToolContext): Promise<HookResult | undefined> {
    return undefined;
  }

  /**
   * 工具执行完成钩子
   */
  protected async onToolFinished(_result: ToolResult): Promise<void> {
    // 移除硬编码依赖：反向钩子通过 HooksRegistry 执行
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

