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

import type { AgentConfig, ToolCall, Tool, Message, HookInspectorSnapshot, UsageInfo, AgentOverviewSnapshot, ImageInput, LLMMeta } from './types.js';
import type { AgentFeature, FeatureInitContext, FeatureContext, ContextInjector } from './feature.js';
import type { TemplateSource, PlaceholderContext } from '../template/types.js';
import { ToolRegistry } from './tool.js';
import { Context, type ContextSnapshot } from './context.js';
import { DebugHub } from './debug-hub.js';
import { createLogger, installConsoleBridge, runWithLogScope } from './logging.js';
import { runWithNotificationScope } from './notification.js';
import { captureFeatureSnapshots, restoreFeatureSnapshots } from './checkpoint.js';
import { loadFeatureModule, isFeatureInitFailureError, type FeatureReloadOptions, type FeatureReloadResult, type FeatureInitFailureError, type FeatureReloadFailureError } from './feature-reload.js';
import { preflightAssembly } from './feature-preflight.js';
import type { CallContinuationRequest } from './continuation.js';
import {
  getDefaultSessionStore,
  type AgentRuntimeSnapshot,
  type RuntimeStateWithoutContext,
  type AgentSessionSnapshot,
  type SessionStore,
  type CallRollbackSnapshot,
  type CallRollbackSnapshotV2,
  type NamedCheckpoint,
} from './session-store.js';
import type { ContextBoundaryV2 } from './context.js';
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
import { DataSourceRegistry } from '../template/data-source.js';
import { TemplateLoader } from '../template/loader.js';
import { discover } from '../skills/loader.js';
import type { SkillMetadata } from '../skills/types.js';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// 导入重构后的模块
import { HookErrorHandling, executeHook } from './agent/hooks-executor.js';
import { type LifecycleHooks } from './agent/lifecycle-hooks.js';
import { TemplateResolver } from './agent/template-resolver.js';
import { resolveFeatureOrder, orderErrorsToError } from './feature-graph.js';
import { validatePolicyUniqueness, issuesToError } from './hook-declarations.js';
import { ToolExecutor } from './agent/tool-executor.js';
import { ReActLoopRunner } from './agent/react-loop.js';
import type { DebugPusher } from './agent/types.js';

// 导入钩子注册表
import { HooksRegistry, type HookExecutionResult, type HookInvocationObserver } from './hooks-registry.js';
import { CoreLifecycle, Decision } from './lifecycle.js';

// Re-export ContextSnapshot and HookErrorHandling for convenience
export type { ContextSnapshot };
export { HookErrorHandling };
export type { AgentSessionSnapshot, SessionStore };

/**
 * 内部 call checkpoint 类型 — v2 union。
 * 新 checkpoint 为 'context-boundary'，从老会话加载的为 'legacy-full-snapshot'。
 */
type CallRollbackCheckpoint = CallRollbackSnapshotV2;

// 基础类（不含生命周期钩子）
class AgentBase {
  protected readonly logger = createLogger('agent.runtime');

  /**
   * feature 事件流 logger（C 项）：生命周期事件必须自带 agentId/agentName
   * （mount/remove/reload 常在 onCall 之外调用，日志 scope 中没有 agent 上下文）
   */
  private featureEventLogger(featureName: string) {
    return this.logger.child({
      namespace: 'agent.features',
      feature: featureName,
      agentId: this.agentId,
      agentName: this.config?.name || this.constructor.name,
    });
  }
  // ========== 属性 ==========

  protected llm: AgentConfig['llm'];
  protected tools: ToolRegistry;
  protected maxTurns: number;
  protected systemMessage?: string | TemplateSource;
  protected config: AgentConfig;
  protected templateLoader: TemplateLoader;
  protected persistentContext?: Context;
  protected debugHub?: DebugHub;
  /** Stable process-local identity; Viewer attachment reuses this exact ID. */
  protected readonly agentId: string;
  protected debugEnabled: boolean = false;

  // 子代理相关
  protected _agentId?: string;
  protected _parentPool?: any; // AgentPool reference from parent

  // Agent 类型注册表（实例级，由子类构造函数自行注册可创建的子代理类型）
  private _agentTypeRegistry = new Map<string, () => AgentBase | Promise<AgentBase>>();

  // Feature 系统
  private features = new Map<string, AgentFeature>();
  private contextInjectors: Array<{
    pattern: string | RegExp;
    injector: ContextInjector;
  }> = [];
  private featureToolsReady: boolean = false;
  private featureToolsReadyPromise?: Promise<void>;

  // 同一 Agent 实例维护单条会话状态链，因此 call 必须按提交顺序执行。
  // 队列始终被错误吸收，避免一次失败阻塞后续调用。
  private _callQueue: Promise<void> = Promise.resolve();
  private _activeCallPromise?: Promise<void>;
  private _lifecycleState: 'active' | 'disposing' | 'disposed' = 'active';
  private _disposePromise?: Promise<void>;

  // 反向钩子注册表
  private hooksRegistry = new HooksRegistry();

  // 生命周期状态
  protected _initialized: boolean = false;
  protected _currentCallInput?: string;
  protected _currentStep: number = 0;   // ReAct 循环步骤序号
  protected _callIndex: number = -1;     // 用户交互序号（onCall 次数）
  protected _callStartTimes: Map<number, number> = new Map();
  protected _callCheckpoints: CallRollbackCheckpoint[] = [];
  protected _namedCheckpoints: NamedCheckpoint[] = [];

  // 用量统计
  protected usageStats: UsageStats = new UsageStats();

  // Continuation request（控制工具通过 registerContinuationRequest 登记）
  private _continuationRequest: CallContinuationRequest | null = null;

  // 用户输入缓存（用于 Feature 修改待注入的输入内容）
  private _pendingInput: string | null = null;

  // 中断控制：外部可通过 interrupt() 中断正在运行的 onCall
  private _abortController: AbortController | null = null;
  private _lastCallOutcome: import('./lifecycle.js').CallOutcome | null = null;

  // Step 级自动保存配置
  private _stepAutoSave?: { sessionId: string; store: SessionStore };

  // 模块实例（延迟初始化）
  private templateResolver?: TemplateResolver;
  private toolExecutor?: ToolExecutor;
  private reactRunner?: ReActLoopRunner;

  /** Agent 级数据源注册表（per-Agent 实例，非进程全局） */
  private _dataSourceRegistry = new DataSourceRegistry();

  // ========== LLM 热切换 ==========
  /** 与 LLMClient 实例解耦的模型元数据 */
  private _llmMeta: LLMMeta = {};
  /** 外部消费者通过 onLLMSwap() 注册的回调 */
  private _llmSwapCallbacks: Array<(newLLM: AgentConfig['llm'], oldLLM: AgentConfig['llm']) => void> = [];

  constructor(config: AgentConfig) {
    installConsoleBridge();
    this.agentId = DebugHub.getInstance().allocateAgentId();
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
      this._dataSourceRegistry
    );

    // 注册工具
    if (config.tools) {
      for (const tool of config.tools) {
        this.tools.register(tool);
      }
    }
  }

  observeHookInvocations(observer: HookInvocationObserver): () => void {
    return this.hooksRegistry.observeInvocations(observer);
  }

  // ========== 钩子错误处理策略 ============
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
   * 登记一个 continuation request
   *
   * 控制工具（如 checkpoint、rollback）在正常完成执行后调用此方法，
   * 使当前 onCall 在工具结果闭合后停止，并将请求传递给宿主。
   *
   * 该方法仅在 onCall 执行期间有效。onCall 开始时会清理上一次的遗留请求。
   */
  registerContinuationRequest(request: CallContinuationRequest): void {
    if (this._continuationRequest) {
      throw new Error(
        `Continuation request already registered: kind=${this._continuationRequest.kind}. ` +
        `Only one continuation request per onCall is allowed.`
      );
    }
    this._continuationRequest = request;
    this.logger.info('Continuation request registered', { kind: request.kind });
  }

  /**
   * 消费当前 continuation request（一次性）
   *
   * 宿主（如 CallArbiter）在 onCall 返回后调用此方法，
   * 判断是否需要在同一逻辑 envelope 内启动下一个 segment。
   *
   * - 请求只能消费一次，消费后自动清除。
   * - onCall 开始时也会清理上次未消费的请求。
   *
   * @returns 当前 continuation request，如果没有则返回 null
   */
  consumeContinuationRequest(): CallContinuationRequest | null {
    const request = this._continuationRequest;
    this._continuationRequest = null;
    return request;
  }

  /**
   * 唯一的公开入口 - 执行 Agent。
   *
   * 同一实例的会话状态不可并发访问；后续调用会按提交顺序排队。
   */
  async onCall(input: string, images?: ImageInput[]): Promise<string> {
    const outcome = await this.onCallDetailed(input, images);
    return outcome.response;
  }

  /**
   * 执行一次 Agent Call 并返回结构化终态。
   *
   * `onCall()` 保持字符串返回以兼容既有 Agent；宿主、CLI 与自动化调用
   * 应使用本方法根据 status/reason/error 判断实际执行结果。
   */
  async onCallDetailed(input: string, images?: ImageInput[]): Promise<import('./lifecycle.js').CallOutcome> {
    if (this._lifecycleState !== 'active') {
      throw new Error('Agent is disposing or has been disposed');
    }

    const queuedCall = this._callQueue.then(async () => {
      if (this._lifecycleState !== 'active') {
        throw new Error('Agent is disposing or has been disposed');
      }

      const execution = this.executeCall(input, images);
      const completion = execution.then(() => undefined, () => undefined);
      this._activeCallPromise = completion;
      try {
        return await execution;
      } finally {
        if (this._activeCallPromise === completion) {
          this._activeCallPromise = undefined;
        }
      }
    });

    // 保持内部队列可继续推进，即使某个 call 失败。
    this._callQueue = queuedCall.then(() => undefined, () => undefined);
    return queuedCall;
  }

  /** 最近一次已结束 Call 的结构化终态；没有执行历史时返回 null。 */
  getLastCallOutcome(): import('./lifecycle.js').CallOutcome | null {
    return this._lastCallOutcome ? { ...this._lastCallOutcome } : null;
  }

  private async executeCall(input: string, images?: ImageInput[]): Promise<import('./lifecycle.js').CallOutcome> {
    // 确保 Feature 工具已注册
    await this.ensureFeatureTools();
    if (this._lifecycleState !== 'active') {
      throw new Error('Agent is disposing or has been disposed');
    }

    // 清理上次 onCall 遗留的 continuation request
    this._continuationRequest = null;

    // ========== Call Start ==========
    const context = this.persistentContext ?? new Context();
    // Ensure persistentContext points to the active context immediately,
    // so that stepSaveFn (triggered after each ReAct step) saves the
    // correct context rather than a stale reference.
    this.persistentContext = context;
    const nextCallIndex = this._callIndex + 1;
    const isFirstCall = nextCallIndex === 0;
    const callStartTime = Date.now();
    const callId = Date.now();

    // 创建 AbortController 用于本次 call 的中断控制
    this._abortController = new AbortController();

    // 递增 callIndex（用户交互序号）
    this._callIndex = nextCallIndex;

    this._currentCallInput = input;
    this._callStartTimes.set(callId, callStartTime);

    const agentName = this.config.name || this.constructor.name;

    return runWithNotificationScope(this.agentId!, () =>
      runWithLogScope({
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

      let preCallBoundary: ContextBoundaryV2 | undefined;
      let preCallRuntimeState: RuntimeStateWithoutContext | undefined;
      let finalInput: string | undefined;
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


      // ========== CallStart 反向钩子 ==========
      // 在系统提示词之后、用户输入之前调用，确保 Feature 可以正确注入消息

      // 设置输入缓存（Feature 可以在钩子中通过 setUserInput 修改）
      this._pendingInput = input;

      // 执行反向钩子，Feature 可以在此期间修改 _pendingInput
      await this.hooksRegistry.executeVoid(CoreLifecycle.CallStart, { input, context, isFirstCall, agent: this });
      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();

      // 在 CallStart 钩子之后、用户消息之前捕获边界，
      // 确保 checkpoint 包含 Feature 注入的内容（CLAUDE.md、交接摘要等）。
      preCallBoundary = context.captureBoundary();
      preCallRuntimeState = await this.captureRuntimeStateWithoutContext(this._callIndex - 1);

      // 发送 call.start 通知（供前端消费 agent 运行状态）
      try {
        const { emitNotification, createCallStart } = await import('./notification.js');
        emitNotification(createCallStart());
      } catch { /* notification 模块不可用 */ }

      // 会话事件流：turn.started
      try {
        const { emitSessionEvent } = await import('./session-events.js');
        emitSessionEvent({ type: 'turn.started', turn: this._callIndex });
      } catch { /* session-events 模块不可用 */ }

      // 添加用户输入（使用可能被 Feature 修改过的缓存）
      finalInput = this._pendingInput ?? input;
      context.addUserMessage(finalInput, this._callIndex, images);
      this.pushToDebug(context.getAll());

      // 提前提交 rollback checkpoint：确保在 ReAct 循环中的 step auto-save
      // 持久化时，当前 call 的 checkpoint 已存在。这消除了"消息已持久化但
      // checkpoint 缺失"的竞态窗口。
      this.commitCallCheckpoint({
        kind: 'context-boundary',
        callIndex: this._callIndex,
        draftInput: finalInput,
        contextBoundary: preCallBoundary,
        runtimeState: preCallRuntimeState,
      });

      // ========== 初始化执行器（延迟初始化）==========
      this.ensureExecutorsInitialized();

      // ========== ReAct 循环 ==========
      const result = await this.reactRunner!.run(input, context, { isFirstCall, callIndex: this._callIndex, signal: this._abortController?.signal });

      // 保存上下文
      this.persistentContext = context;
      const outcome = this.createCallOutcome(result, callStartTime);
      this._lastCallOutcome = outcome;

      // ========== Call Finish（成功）==========
      await executeHook(
        this,
        () => (this as any).onCallFinish({
          input,
          context,
          response: result.finalResponse,
          turns: result.turns,
          completed: result.completed,
          finishReason: result.finishReason,
          outcome,
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
        finishReason: result.finishReason,
        outcome,
      });

      // 发送 call.finish 通知（成功）
      try {
        const { emitNotification, createCallFinish } = await import('./notification.js');
        emitNotification(createCallFinish(outcome));
      } catch { /* notification 模块不可用 */ }

      // 会话事件流：turn.completed / turn.failed
      try {
        const { emitSessionEvent, emitTurnCompleted, emitTurnFailed } = await import('./session-events.js');
        if (result.completed) {
          const callUsage = this.usageStats.getCallUsage(this._callIndex)?.totalUsage;
          emitTurnCompleted(
            this._callIndex,
            callUsage && {
              inputTokens: callUsage.inputTokens,
              outputTokens: callUsage.outputTokens,
              totalTokens: callUsage.totalTokens,
            },
          );
        } else {
          emitTurnFailed(this._callIndex, outcome);
        }
      } catch { /* session-events 模块不可用 */ }

        this.logger.info('Call completed', {
          completed: result.completed,
          turns: result.turns,
          durationMs: Date.now() - callStartTime,
        });
        return outcome;

      } catch (error) {
      // ========== Call Finish（异常）==========
      const errorMsg = error instanceof Error ? error.message : String(error);

      // 保留异常发生后最新的上下文状态。
      // 如果 step-level rollback 已触发，这里保存的就是回滚后的上下文。
      this.persistentContext = context;

      // 失败调用也提交 checkpoint，保持与成功调用对称
      if (preCallBoundary && preCallRuntimeState && finalInput !== undefined) {
        this.commitCallCheckpoint({
          kind: 'context-boundary',
          callIndex: this._callIndex,
          draftInput: finalInput,
          contextBoundary: preCallBoundary,
          runtimeState: preCallRuntimeState,
        });
      }

      // 如果是子代理，报告错误中断给父代理
      if (this._agentId && this._parentPool) {
        const errorResult = `[执行出错: ${errorMsg}]`;
        await this._parentPool.handleInterrupt(
          this._agentId,
          'error',
          errorResult
        );
      }

      const outcome: import('./lifecycle.js').CallOutcome = {
        status: 'failed',
        reason: 'error',
        response: errorMsg,
        steps: this._currentStep + 1,
        startedAt: callStartTime,
        finishedAt: Date.now(),
        error: { category: 'exception', message: errorMsg },
      };
      this._lastCallOutcome = outcome;

      await executeHook(
        this,
        () => (this as any).onCallFinish({
          input,
          context,
          response: errorMsg,
          turns: this._currentStep + 1,
          completed: false,
          finishReason: outcome.reason,
          outcome,
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
        finishReason: outcome.reason,
        outcome,
      });

      // 发送 call.finish 通知（异常）
      try {
        const { emitNotification, createCallFinish } = await import('./notification.js');
        emitNotification(createCallFinish(outcome));
      } catch { /* notification 模块不可用 */ }

      // 会话事件流：turn.failed（异常路径）
      try {
        const { emitTurnFailed } = await import('./session-events.js');
        emitTurnFailed(this._callIndex, outcome);
      } catch { /* session-events 模块不可用 */ }

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

         // 不清理 _abortController，让它保持可用以便 interrupt 调用
         // 下次 onCall 会创建新的 AbortController 并覆盖旧的

        }
     })
    );
   }

  /**
   * 启用可视化查看器
   */
  async withViewer(
    name?: string,
    port?: number,
    openBrowser?: boolean,
    options?: { projectRoot?: string; inputPolicy?: 'standard' | 'none' }
  ): Promise<this> {
    this.debugHub = DebugHub.getInstance();
    this.debugEnabled = true;

    // `currentAgentId` belongs to Viewer focus and says nothing about whether
    // this host process has a usable transport. Every Agent attachment joins
    // the same DebugHub connection barrier; start() is idempotent once ready.
    await this.debugHub.start(port, openBrowser);

    // 收集 Feature 模板信息（使用新的统一方式）
    const featureTemplates: Record<string, string> = {};

    for (const feature of this.features.values()) {
      // 使用 getPackageInfo() + getTemplateNames() 方式
      if (feature.getPackageInfo && feature.getTemplateNames) {
        const pkgInfo = feature.getPackageInfo();
        const templateNames = feature.getTemplateNames();

        if (pkgInfo && templateNames.length > 0) {
          // 判别该 feature 的模板在包内的实际布局，以决定 URL 是否带 feature 段：
          // - 单 feature 独立包（@agentdev/shell-feature 等）：模板在 <root>/dist/templates/
          // - 多 feature 框架包（@agentdev/core）：模板在 <root>/dist/features/<feature>/templates/
          const hasFeatureSubdir = existsSync(
            join(pkgInfo.root, 'dist', 'features', feature.name, 'templates')
          );
          for (const templateName of templateNames) {
            // 独立包：/template/{packageName}/{templateName}.render.js
            // 框架包：/template/{packageName}/{featureName}/{templateName}.render.js
            const url = hasFeatureSubdir
              ? `/template/${pkgInfo.name}/${feature.name}/${templateName}.render.js`
              : `/template/${pkgInfo.name}/${templateName}.render.js`;
            featureTemplates[templateName] = url;
          }
        }
      }
    }

    const wasRegistered = this.debugHub.isAgentRegistered(this.agentId);
    const registeredAgentId = this.debugHub.registerAgent(
      this,
      name || this.constructor.name,
      featureTemplates,
      this.buildHookInspectorSnapshot(),
      this.buildOverviewSnapshot(),
      options?.projectRoot ?? this.config.projectRoot,
      this.agentId,
      options?.inputPolicy,
    );
    if (registeredAgentId !== this.agentId) {
      throw new Error(`DebugHub registered unexpected Agent ID '${registeredAgentId}'`);
    }

    try {
      await this.ensureFeatureTools();

      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();
      for (const feature of this.features.values()) {
        const maybePushSnapshot = (feature as any).pushDebugSnapshot;
        if (typeof maybePushSnapshot === 'function') {
          try {
            maybePushSnapshot.call(feature, this.agentId);
          } catch (error) {
            console.warn(`[Agent] Feature '${feature.name}' debug snapshot push failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (this.persistentContext) {
        this.pushToDebug(this.persistentContext.getAll());
      }
    } catch (error) {
      if (!wasRegistered) {
        this.debugHub.unregisterAgent(this.agentId);
      }
      this.debugEnabled = wasRegistered;
      throw error;
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
      version: 2,
      sessionId,
      savedAt: Date.now(),
      agentType: this.constructor.name,
      runtime,
      rollbackHistory: this._callCheckpoints,
      ...(this._namedCheckpoints.length > 0
        ? { namedCheckpoints: this._namedCheckpoints.map(cp => ({ ...cp, runtime: { ...cp.runtime } })) }
        : {}),
    };
  }

  /**
   * 从会话快照恢复
   */
  async restoreSessionSnapshot(snapshot: AgentSessionSnapshot): Promise<this> {
    await this.ensureFeatureTools();
    const normalized = this.normalizeSessionSnapshot(snapshot as AgentSessionSnapshot & Record<string, unknown>);
    await this.restoreRuntimeSnapshot(normalized.runtime);

    // 恢复 rollback history，处理 v1/v2 混合格式
    const rawHistory = normalized.rollbackHistory as unknown as Array<Record<string, unknown>>;
    this._callCheckpoints = rawHistory.map(entry => this.normalizeCheckpointEntry(entry));

    // 恢复命名检查点（如果快照中包含）
    this._namedCheckpoints = (snapshot as AgentSessionSnapshot).namedCheckpoints
      ? [...(snapshot as AgentSessionSnapshot).namedCheckpoints!]
      : [];

    return this;
  }

  /**
   * 中断正在运行的 onCall
   * 会触发 AbortController，在下一个检查点（step 间或 tool 执行中）优雅停止
   * 返回 true 表示成功触发中断，false 表示当前没有正在运行的 call
   */
  interrupt(): boolean {
    if (this.isRunning() && this._abortController && !this._abortController.signal.aborted) {
      this._abortController.abort(new Error('Interrupted by user'));
      this.logger.info('Interrupt triggered', { callIndex: this._callIndex });
      return true;
    }
    return false;
  }

  /**
   * 当前是否正在执行 onCall
   */
  isRunning(): boolean {
    return this._currentCallInput !== undefined;
  }

  // ========== LLM 热切换 ==========

  /**
   * 热替换 LLM 实例
   *
   * - 更新 Agent.llm + ReActLoopRunner 内部引用
   * - 更新模型元数据（_llmMeta）
   * - 触发 Feature.onLLMSwap() 和已注册的回调
   * - 更新 SystemContext 中的 SYSTEM_CURRENT_MODEL
   * - 推送 Overview Snapshot（使前端立即看到新模型名）
   *
   * @param llm 新的 LLM 实例
   * @param meta 可选：模型元数据（contextLength、compressRatio 等）
   *
   * 允许在 onCall 运行期间调用（mid-turn swap）。在途的 LLM 请求由旧实例的
   * Promise 持有，不受引用替换影响；下一个 ReAct step 会同步读取新引用。
   */
  setLLM(llm: AgentConfig['llm'], meta?: LLMMeta): void {
    const oldLLM = this.llm;
    this.llm = llm;

    if (meta) {
      this._llmMeta = { ...meta };
    }

    // 更新 SystemContext 中的模型名（为将来可能的模板重解析做准备）
    if (meta?.modelName) {
      const ctx = this.templateResolver?.getSystemContext();
      if (ctx) {
        ctx.SYSTEM_CURRENT_MODEL = meta.modelName;
      }
    }

    // 同步 ReActLoopRunner 内部持有的 LLM 引用（消除引用快照卡点）
    if (this.reactRunner) {
      this.reactRunner.swapLLM(llm);
    }

    // 触发 Feature 的 onLLMSwap 钩子
    for (const feature of this.features.values()) {
      if (typeof feature.onLLMSwap === 'function') {
        try {
          feature.onLLMSwap(llm, oldLLM);
        } catch (error) {
          this.logger.warn(`Feature ${feature.name} onLLMSwap error`, { error });
        }
      }
    }

    // 触发外部注册的回调
    for (const callback of this._llmSwapCallbacks) {
      try {
        callback(llm, oldLLM);
      } catch (error) {
        this.logger.warn('onLLMSwap callback error', { error });
      }
    }

    // 推送新 Overview Snapshot
    this.pushOverviewSnapshot();

    this.logger.info('LLM swapped', {
      newModel: (llm as any)?.modelName,
      oldModel: (oldLLM as any)?.modelName,
    });
  }

  /**
   * 注册 LLM 变更回调
   *
   * 外部消费者（如 Claw 的 run-prebuilt-agent.js）可在 setLLM 时收到通知。
   * 回调在 Feature.onLLMSwap 之后同步执行。
   */
  onLLMSwap(callback: (newLLM: AgentConfig['llm'], oldLLM: AgentConfig['llm']) => void): void {
    this._llmSwapCallbacks.push(callback);
  }

  /**
   * 获取当前模型元数据（不可变副本）
   */
  getLLMMeta(): LLMMeta {
    return { ...this._llmMeta };
  }

  async rollbackToCall(callIndex: number): Promise<{ draftInput: string }> {
    await this.ensureFeatureTools();
    const checkpoint = this._callCheckpoints.find(entry => entry.callIndex === callIndex);
    if (!checkpoint) {
      throw new Error(`Rollback checkpoint for call ${callIndex} not found`);
    }

    if (checkpoint.kind === 'context-boundary') {
      // v2 增量 rollback：截断 Context + 恢复运行态
      const context = this.getContext();
      context.truncateToBoundary(checkpoint.contextBoundary);
      await this.restoreRuntimeStateWithoutContext(checkpoint.runtimeState);
    } else {
      // v1 legacy rollback：完整 runtime 恢复
      await this.restoreRuntimeSnapshot(checkpoint.runtime);
    }

    this._callCheckpoints = this._callCheckpoints.filter(entry => entry.callIndex < callIndex);
    this.pushToDebug(this.getContext().getAll());
    this.pushInspectorSnapshot();

    return { draftInput: checkpoint.draftInput };
  }

  /**
   * 预注入 CallStart 钩子内容（不触发完整 onCall 流程）。
   *
   * 用于新 session 在首次用户输入前就能展示注入的上下文（如 handoff 摘要、CLAUDE.md）。
   * 执行初始化（如果尚未初始化）和 CallStart 钩子，但不添加用户消息、不进入 ReAct 循环。
   * Feature 的状态守卫（如 injected 标志）确保后续真实 onCall 时不会重复注入。
   */
  async preInjectCallStart(): Promise<void> {
    await this.ensureFeatureTools();

    const context = this.persistentContext ?? new Context();
    this.persistentContext = context;

    // 首次初始化（与 onCall 中的逻辑一致）
    if (!this._initialized) {
      await executeHook(
        this,
        () => (this as any).onInitiate({ context }),
        { hookName: 'onInitiate', input: '' }
      );
      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();

      if (this.templateResolver && context.getAll().length === 0) {
        const systemMsg = await this.templateResolver.resolve();
        if (systemMsg) {
          context.addSystemMessage(systemMsg, this._callIndex);
        }
      }

      this._initialized = true;
    }

    // 执行 CallStart 钩子（isFirstCall = true）
    await this.hooksRegistry.executeVoid(CoreLifecycle.CallStart, {
      input: '',
      context,
      isFirstCall: true,
      agent: this,
    });
    this.syncRegisteredToolsToDebug();
    this.pushInspectorSnapshot();
  }

  /**
   * 创建一个命名检查点
   *
   * 捕获当前完整 runtime snapshot 并将其与 checkpointId 关联。
   * 应在 onCall 完全退出后、由宿主（CallArbiter）的 checkpoint barrier 调用。
   *
   * @param id 全局唯一的 checkpoint ID
   * @returns 创建的 NamedCheckpoint
   */
  async createNamedCheckpoint(id: string): Promise<NamedCheckpoint> {
    await this.ensureFeatureTools();

    if (this._namedCheckpoints.some(cp => cp.id === id)) {
      throw new Error(`Named checkpoint "${id}" already exists`);
    }

    const runtime = await this.captureRuntimeSnapshot(this.persistentContext, this._callIndex);
    const checkpoint: NamedCheckpoint = {
      id,
      createdAt: Date.now(),
      sourceCallIndex: this._callIndex,
      runtime,
    };
    this._namedCheckpoints.push(checkpoint);
    this.logger.info('Named checkpoint created', { id, callIndex: this._callIndex });
    return checkpoint;
  }

  /**
   * 回退到命名检查点
   *
   * 恢复到指定 checkpoint 的 runtime snapshot，
   * 并剪除该 checkpoint 之后创建的所有命名检查点。
   * 应在 onCall 完全退出后、由宿主（CallArbiter）的 rollback barrier 调用。
   *
   * @param id 目标 checkpoint ID
   * @throws 如果 checkpoint 不存在
   */
  async rollbackToNamedCheckpoint(id: string): Promise<void> {
    await this.ensureFeatureTools();

    const targetIndex = this._namedCheckpoints.findIndex(cp => cp.id === id);
    if (targetIndex === -1) {
      throw new Error(`Named checkpoint "${id}" not found`);
    }

    const checkpoint = this._namedCheckpoints[targetIndex];
    await this.restoreRuntimeSnapshot(checkpoint.runtime);

    // 剪除该 checkpoint 之后创建的所有命名检查点（基于位置，避免时间戳精度问题）
    this._namedCheckpoints = this._namedCheckpoints.slice(0, targetIndex + 1);

    this.pushToDebug(this.getContext().getAll());
    this.pushInspectorSnapshot();
    this.logger.info('Rolled back to named checkpoint', { id, callIndex: checkpoint.sourceCallIndex });
  }

  /**
   * 获取所有命名检查点（只读视图）
   */
  getNamedCheckpoints(): readonly NamedCheckpoint[] {
    return this._namedCheckpoints;
  }

  /**
   * 清除所有命名检查点
   *
   * 用于单 checkpoint 模式：创建新 checkpoint 前清除旧的。
   */
  clearNamedCheckpoints(): void {
    this._namedCheckpoints = [];
  }

  /**
   * 保存会话到持久化存储
   */
  async saveSession(sessionId: string, store: SessionStore = getDefaultSessionStore()): Promise<string> {
    const snapshot = await this.createSessionSnapshot(sessionId);
    return store.save(sessionId, snapshot);
  }

  /**
   * 启用 Step 级自动保存：每个 ReAct step 完成后自动将 session 快照写入磁盘。
   * 不会替换 CallFinish 后的 saveSession 调用——后者仍作为兜底全量保存。
   */
  enableStepAutoSave(sessionId: string, store: SessionStore): void {
    this._stepAutoSave = { sessionId, store };
    // 传播到 reactRunner（如果已初始化）
    if (this.reactRunner) {
      (this.reactRunner as any).agent.stepSaveFn = this._createStepSaveFn();
    }
  }

  /**
   * 禁用 Step 级自动保存
   */
  disableStepAutoSave(): void {
    this._stepAutoSave = undefined;
    if (this.reactRunner) {
      (this.reactRunner as any).agent.stepSaveFn = undefined;
    }
  }

  private _createStepSaveFn(): (() => Promise<void>) | undefined {
    if (!this._stepAutoSave) return undefined;
    const { sessionId, store } = this._stepAutoSave;
    return async () => {
      await this.saveSession(sessionId, store);
    };
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
    this._namedCheckpoints = [];
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
   * 注册一个可创建的子代理类型
   *
   * 通常在 Agent 子类的构造函数中调用：
   * this.registerAgentType('MyAgent', () => new MyAgent({ llm: this.llm }));
   */
  public registerAgentType(name: string, factory: () => AgentBase | Promise<AgentBase>): this {
    this._agentTypeRegistry.set(name, factory);
    return this;
  }

  /**
   * 获取当前已注册的所有子代理类型名
   */
  public getRegisteredAgentTypes(): string[] {
    return Array.from(this._agentTypeRegistry.keys());
  }

  /**
   * 创建 Agent 实例
   *
   * 优先从实例注册表查找，未命中则 fallback 到内置类型（向后兼容）。
   * 子类无需覆盖此方法，通过 registerAgentType() 即可扩展。
   */
  public async createAgentByType(type: string): Promise<AgentBase> {
    // 优先查实例注册表
    const factory = this._agentTypeRegistry.get(type);
    if (factory) return factory();

    // fallback: 内置类型（向后兼容）
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
    if (this._disposePromise) {
      return this._disposePromise;
    }

    this._lifecycleState = 'disposing';
    this._disposePromise = this.disposeInternal();
    return this._disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    // 已开始的 call 先中断，再等待活动调用和已排队调用收敛。
    // 排队调用会在开始前观察到 disposing 状态并明确失败。
    this.interrupt();
    await this._activeCallPromise;
    await this._callQueue;

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
          await feature.onDestroy({
            agentId: this.agentId,
            config: this.config,
            getFeature: <T extends AgentFeature>(featureName: string): T | undefined => {
              return this.features.get(featureName) as T | undefined;
            },
          });
        } catch (error) {
          console.warn(`[Agent] Feature ${feature.name} cleanup error:`, error);
        }
      }
    }

    // 注销 DebugHub
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.unregisterAgent(this.agentId);
      this.debugEnabled = false;
    }

    // 重置状态
    this._initialized = false;
    this.persistentContext = undefined;
    this._callCheckpoints = [];
    this._lifecycleState = 'disposed';
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
   * 彻底移除一个 Feature：移除其工具并从 features Map 中删除
   *
   * @example
   * agent.removeFeature('subagent')  // 移除 SubAgentFeature
   */
  removeFeature(featureName: string): this {
    const feature = this.features.get(featureName);
    if (!feature) {
      console.warn(`[Agent] Feature '${featureName}' 不存在`);
      return this;
    }

    // 移除工具
    const tools = feature.getTools?.() ?? [];
    let count = 0;
    for (const tool of tools) {
      if (this.tools.remove(tool.name)) {
        count++;
      }
    }

    // 移除反向钩子
    this.hooksRegistry.removeFromFeature(feature);

    // 清理 contextInjectors
    if (feature.getContextInjectors) {
      const injectors = feature.getContextInjectors();
      for (const [pattern] of injectors) {
        const idx = this.contextInjectors.findIndex(ci => ci.pattern === pattern && ci.injector);
        if (idx !== -1) {
          this.contextInjectors.splice(idx, 1);
        }
      }
    }

    // 从 features Map 中移除
    this.features.delete(featureName);

    // 调用 onDestroy 清理资源
    if (typeof feature.onDestroy === 'function') {
      try {
        feature.onDestroy({
          agentId: this.agentId,
          config: this.config,
          getFeature: <T extends AgentFeature>(name: string): T | undefined => {
            return this.features.get(name) as T | undefined;
          },
        });
      } catch (err) {
        console.warn(`[Agent] Feature '${featureName}' onDestroy error:`, err);
      }
    }

    if (count > 0) {
      this.syncRegisteredToolsToDebug();
    }
    this.featureEventLogger(featureName).info(
      `feature '${featureName}' removed (${count} tools + hooks + feature instance)`,
      { event: 'feature.removed', toolCount: count }
    );
    this.pushInspectorSnapshot();

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
      this.featureEventLogger(featureName).info(
        `feature '${featureName}' tools enabled (${count})`,
        { event: 'feature.tool_state_changed', action: 'enabled', toolCount: count }
      );
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
      this.featureEventLogger(featureName).info(
        `feature '${featureName}' tools disabled (${count})`,
        { event: 'feature.tool_state_changed', action: 'disabled', toolCount: count }
      );
      this.syncRegisteredToolsToDebug();
      this.pushInspectorSnapshot();
    }

    return this;
  }

  /**
   * 移除 Feature 的所有工具（从 LLM 工具列表物理移除）
   *
   * @example
   * agent.remove('mcp')  // 移除 MCP 工具
   */
  remove(featureName: string): this {
    const feature = this.features.get(featureName);
    if (!feature) {
      console.warn(`[Agent] Feature '${featureName}' 不存在`);
      return this;
    }

    const tools = feature.getTools?.() ?? [];
    let count = 0;
    for (const tool of tools) {
      if (this.tools.remove(tool.name)) {
        count++;
      }
    }

    if (count > 0) {
      this.featureEventLogger(featureName).info(
        `feature '${featureName}' tools removed (${count})`,
        { event: 'feature.tool_state_changed', action: 'removed', toolCount: count }
      );
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

  // ========== 反向钩子运行时控制 ==========

  /**
   * 禁用指定的反向钩子
   *
   * @example
   * agent.disableHook('ToolUse', 'audit', 'onToolUse')
   */
  disableHook(lifecycle: string, featureName: string, methodName: string): this {
    const lc = lifecycle as CoreLifecycle;
    if (this.hooksRegistry.disableHook(lc, featureName, methodName)) {
      this.logger.child({
        namespace: 'agent.features',
        feature: featureName,
        agentId: this.agentId,
        agentName: this.config?.name || this.constructor.name,
        lifecycle,
        hookMethod: methodName,
      }).info(
        `hook ${lifecycle}:${featureName}.${methodName} disabled`,
        { event: 'feature.hook_state_changed', action: 'disabled' }
      );
      this.pushInspectorSnapshot();
    }
    return this;
  }

  /**
   * 启用指定的反向钩子
   *
   * @example
   * agent.enableHook('ToolUse', 'audit', 'onToolUse')
   */
  enableHook(lifecycle: string, featureName: string, methodName: string): this {
    const lc = lifecycle as CoreLifecycle;
    if (this.hooksRegistry.enableHook(lc, featureName, methodName)) {
      this.logger.child({
        namespace: 'agent.features',
        feature: featureName,
        agentId: this.agentId,
        agentName: this.config?.name || this.constructor.name,
        lifecycle,
        hookMethod: methodName,
      }).info(
        `hook ${lifecycle}:${featureName}.${methodName} enabled`,
        { event: 'feature.hook_state_changed', action: 'enabled' }
      );
      this.pushInspectorSnapshot();
    }
    return this;
  }

  /**
   * 按名称获取已挂载的 Feature 实例
   */
  getFeature<T extends AgentFeature>(featureName: string): T | undefined {
    return this.features.get(featureName) as T | undefined;
  }

  /**
   * 确保 Feature 工具已注册。
   *
   * @param opts.strict 严格模式：feature 的 getAsyncTools / onInitiate 失败
   *   直接抛出（带 featureInitStage 标记），而非 warn 后继续。供 Test Runtime
   *   等宿主在启动期显式验证初始化；onCall 内部调用保持默认非严格。
   */
  async ensureFeatureTools(opts?: { strict?: boolean }): Promise<void> {
    if (this.featureToolsReady) return;
    if (this.featureToolsReadyPromise) {
      return this.featureToolsReadyPromise;
    }

    const initialization = (async () => {
      // 装配校验（工作项 A1/A3）：依赖拓扑 + policy 唯一性。
      // 错误在此处爆出（装配时），不许运行时碰运气。
      const featureList = Array.from(this.features.values());
      const { order, errors: orderErrors } = resolveFeatureOrder(featureList);
      if (orderErrors.length > 0) {
        throw orderErrorsToError(orderErrors);
      }
      const policyIssues = validatePolicyUniqueness(featureList);
      if (policyIssues.length > 0) {
        throw issuesToError(policyIssues);
      }

      // 预收集所有 Feature 自带的 skills，在 onInitiate 之前注入 SkillFeature
      const featureSkills = await this.collectFeatureSkills();
      if (featureSkills.length > 0) {
        const skillFeature = this.features.get('skill') as any;
        if (skillFeature?.addFeatureSkills) {
          skillFeature.addFeatureSkills(featureSkills);
        }
      }

      for (const feature of order) {
        await this.initSingleFeature(feature.name, feature, { strict: opts?.strict === true });
      }

      // 子类可在此 hook 中注册额外工具（如统一代理工具）
      await this.onFeatureToolsReady();

      this.featureToolsReady = true;
      this.pushInspectorSnapshot();
    })();

    this.featureToolsReadyPromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.featureToolsReadyPromise === initialization) {
        this.featureToolsReadyPromise = undefined;
      }
    }
  }

  /**
   * 为单个 Feature 执行工具注册、onInitiate 和 hooks 收集。
   *
   * 被 ensureFeatureTools() 和 mountFeature() 共用。
   *
   * @param opts.strict 严格模式：getAsyncTools / onInitiate 失败直接抛出
   *   （标记 featureInitStage），而非 warn 后以半初始化状态继续。
   */
  private async initSingleFeature(
    name: string,
    feature: AgentFeature,
    opts?: { strict?: boolean },
  ): Promise<void> {
    const featureLogger = createLogger(`feature.${name}`, {
      agentId: this.agentId,
      agentName: this.config.name || this.constructor.name,
      feature: name,
      tags: [`feature:${name}`],
    });

    // 为每个 Feature 创建独立的 initContext
    const initContext: FeatureInitContext = {
      agentId: this.agentId,
      config: this.config,
      logger: featureLogger,
      featureConfig: this.config.features?.[name],
      getFeature: <T extends AgentFeature>(featureName: string): T | undefined => {
        return this.features.get(featureName) as T | undefined;
      },
      registerTool: (tool) => this.tools.register(tool, name),
      dataSourceRegistry: this._dataSourceRegistry,
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
        if (opts?.strict) {
          const initError = new Error(
            `Feature ${name} failed to load tools: ${errorMsg}`,
            { cause: error },
          ) as FeatureInitFailureError;
          initError.featureInitStage = 'getAsyncTools';
          throw initError;
        }
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
        if (opts?.strict) {
          const initError = new Error(
            `Feature ${name} onInitiate failed: ${errorMsg}`,
            { cause: error },
          ) as FeatureInitFailureError;
          initError.featureInitStage = 'onInitiate';
          throw initError;
        }
        console.warn(`[Agent] Feature ${name} onInitiate failed: ${errorMsg}`);
      }
    }

    // 收集反向钩子
    this.hooksRegistry.collectFromFeature(feature);
  }

  /**
   * 动态挂载 Feature（运行时）
   *
   * 与 use() 不同，mountFeature 会在 agent 已初始化的情况下
   * 立即对新 feature 执行工具注册、onInitiate 和 hooks 收集。
   *
   * 如果 agent 尚未初始化（未发生首次 onCall），feature 会被加入 Map，
   * 后续由 ensureFeatureTools() 统一处理。
   *
   * @example
   * await agent.mountFeature(new SomeFeature());
   */
  async mountFeature(feature: AgentFeature, opts?: { strictInit?: boolean }): Promise<this> {
    // 装配预检（工作项 D）：增量挂载点拦截 error 级问题（policy 冲突等）。
    // warning 不阻断（如工具重名覆盖可能是既有语义）。
    const nextAssembly = [...this.features.values(), feature];
    const preflight = preflightAssembly(nextAssembly);
    const errors = preflight.issues.filter(i => i.severity === 'error');
    if (errors.length > 0) {
      throw new Error(
        `mountFeature preflight failed for '${feature.name}':\n` +
          errors.map(e => `  [${e.check}] ${e.message}`).join('\n'),
      );
    }

    this.use(feature);
    this.featureEventLogger(feature.name).info(
      `feature '${feature.name}' mounted${this.featureToolsReady ? ' (immediate init)' : ' (deferred to first call)'}`,
      { event: 'feature.mounted', toolCount: feature.getTools?.()?.length ?? 0 }
    );

    // agent 尚未初始化，feature 会在首次 ensureFeatureTools 时统一处理
    if (!this.featureToolsReady) {
      return this;
    }

    // agent 已初始化，立即对新 feature 执行完整初始化
    await this.initSingleFeature(feature.name, feature, { strict: opts?.strictInit === true });
    this.pushInspectorSnapshot();
    return this;
  }

  /**
   * 热载一个 Feature：不重启 Agent、不丢失会话上下文。
   *
   * 流程（任一步失败自动回退旧实例）：
   * 1. captureState 旧实例（removeFeature 会触发 onDestroy，状态须先取出）
   * 2. removeFeature 卸载旧实例（工具/钩子/injectors）
   * 3. cache-busting 动态 import 加载新模块代码
   * 4. 新实例 restoreState 迁移状态（无状态契约则显式标记丢失）
   * 5. mountFeature 挂载（工具注册 + onInitiate + 钩子收集 + inspector 推送）
   *
   * @param featureName 已挂载的 feature 名
   * @param modulePath 新代码的绝对路径或 file:// URL；
   *                   缺省时读取旧实例构造器上的静态 reloadPath 声明
   * @param opts.strictInit 严格初始化：getAsyncTools / onInitiate 失败视为
   *                        reload 失败并自动回退（阶段标注 'init'）
   * @throws mount/import/init 阶段失败时回退旧实例后重新抛出（错误带
   *         reloadStage / rolledBack 标记，错误信息标注失败阶段）
   */
  async reloadFeature(
    featureName: string,
    modulePath?: string,
    opts?: FeatureReloadOptions,
  ): Promise<FeatureReloadResult> {
    const startedAt = Date.now();
    const oldFeature = this.features.get(featureName);
    if (!oldFeature) {
      throw new Error(
        `Feature reload failed: feature '${featureName}' is not mounted. ` +
          'Mounted features: ' + Array.from(this.features.keys()).join(', '),
      );
    }

    const resolvedModulePath = modulePath
      ?? (oldFeature.constructor as unknown as { reloadPath?: string }).reloadPath;
    if (!resolvedModulePath) {
      throw new Error(
        `Feature reload failed: no modulePath for '${featureName}'. ` +
          'Pass the module path explicitly, or declare `static reloadPath` on the feature class.',
      );
    }

    const oldClassName = oldFeature.constructor.name;
    const canTransferState =
      typeof oldFeature.captureState === 'function' &&
      typeof oldFeature.restoreState === 'function';

    // 捕获旧实例工具的用户决策状态（enabled/disabled/removed）。
    // removeFeature 会把工具打入 pendingRemoved；register() 尊重该标记
    // （用户移除决策跨重注册保持），因此 reload 必须在挂载后恢复原状态——
    // 否则被程序性移除的工具在热载后永久消失。
    const toolStates = new Map<string, 'enabled' | 'disabled' | 'removed'>();
    for (const tool of oldFeature.getTools?.() ?? []) {
      toolStates.set(
        tool.name,
        this.tools.isEnabled(tool.name)
          ? 'enabled'
          : this.tools.isDisabled(tool.name)
            ? 'disabled'
            : 'removed',
      );
    }

    // 1. 先取状态（removeFeature 的 onDestroy 可能释放资源）
    let capturedState: unknown;
    if (canTransferState) {
      capturedState = oldFeature.captureState!();
    } else {
      this.logger?.warn(
        `Feature '${featureName}' has no captureState/restoreState contract; ` +
          'in-memory state will be lost on reload',
      );
    }

    // 2. 卸载旧实例
    this.removeFeature(featureName);

    const rollback = (stage: string, error: unknown): never => {
      // 回退：旧实例重新挂载 + 状态回灌。回退本身的失败向上抛出（状态已不安全）。
      try {
        this.mountFeatureSync(oldFeature);
        if (canTransferState && capturedState !== undefined) {
          oldFeature.restoreState!(capturedState);
        }
        this.restoreToolStates(toolStates);
      } catch (rollbackError) {
        throw new Error(
          `Feature '${featureName}' reload failed at stage '${stage}', and rollback also failed. ` +
            `Original error: ${error instanceof Error ? error.message : String(error)}. ` +
            `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      this.featureEventLogger(featureName).warn(
        `feature '${featureName}' reload failed at stage '${stage}', previous instance restored`,
        { event: 'feature.reload_reverted', reason: `${stage}: ${message}`, durationMs: Date.now() - startedAt }
      );
      const failure = new Error(
        `Feature '${featureName}' reload failed at stage '${stage}': ${message}. ` +
          'Previous instance has been restored.',
        { cause: error },
      ) as FeatureReloadFailureError;
      failure.reloadStage = stage;
      failure.rolledBack = true;
      throw failure;
    };

    // 3. 加载新模块
    let NewCtor: (new () => AgentFeature) | undefined;
    try {
      NewCtor = await loadFeatureModule(resolvedModulePath, oldClassName) as new () => AgentFeature;
    } catch (error) {
      rollback('import', error);
    }

    // 4-5. 新实例 + 状态迁移 + 挂载
    let newFeature: AgentFeature;
    try {
      newFeature = new NewCtor!();
      if (newFeature.name !== featureName) {
        throw new Error(
          `reloaded feature reports name '${newFeature.name}', expected '${featureName}'`,
        );
      }
    } catch (error) {
      rollback('instantiate', error);
    }

    // 状态迁移要求新旧双侧都有契约（与 checkpoint.ts 的采集规则一致）
    const newStateCapable =
      typeof newFeature!.captureState === 'function' &&
      typeof newFeature!.restoreState === 'function';
    let stateTransferred = false;
    if (newStateCapable && canTransferState && capturedState !== undefined) {
      try {
        await newFeature!.restoreState!(capturedState);
        stateTransferred = true;
      } catch (error) {
        rollback('state-transfer', error);
      }
    } else if (canTransferState && !newStateCapable) {
      this.logger?.warn(
        `Feature '${featureName}' new code drops the captureState/restoreState contract; ` +
          'previous state could not be transferred',
      );
    }

    try {
      await this.mountFeature(newFeature!, opts?.strictInit ? { strictInit: true } : undefined);
      this.restoreToolStates(toolStates);
    } catch (error) {
      rollback(isFeatureInitFailureError(error) ? 'init' : 'mount', error);
    }

    const reloadDurationMs = Date.now() - startedAt;
    this.featureEventLogger(featureName).info(
      `feature '${featureName}' reloaded in ${reloadDurationMs}ms (state ${stateTransferred ? 'transferred' : 'not transferred'})`,
      { event: 'feature.reloaded', durationMs: reloadDurationMs, stateTransferred }
    );

    return {
      featureName,
      stateTransferred,
      rolledBack: false,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * 恢复工具的用户决策状态（reloadFeature 专用）。
   *
   * 新代码注册后，工具名若与旧版本一致，恢复 reload 前的
   * enabled/disabled/removed 状态；新工具保持注册默认值。
   */
  private restoreToolStates(states: Map<string, 'enabled' | 'disabled' | 'removed'>): void {
    for (const [name, state] of states) {
      if (state === 'enabled') {
        this.tools.enable(name);
      } else if (state === 'disabled') {
        this.tools.disable(name);
      } else {
        this.tools.remove(name);
      }
    }
  }

  /**
   * mountFeature 的同步回退通道：reloadFeature 失败时恢复旧实例。
   *
   * 与 mountFeature 的区别：不做 inspector 推送延迟（立即同步注册），
   * 供回退路径在抛错前完成恢复。
   */
  private mountFeatureSync(feature: AgentFeature): void {
    this.use(feature);
    if (this.featureToolsReady) {
      this.initSingleFeatureSync(feature);
    }
  }

  /**
   * initSingleFeature 的同步变体（回退路径专用，不等待异步初始化）。
   */
  private initSingleFeatureSync(feature: AgentFeature): void {
    if (feature.getTools) {
      for (const tool of feature.getTools() || []) {
        this.tools.register(tool, feature.name);
      }
    }
    this.hooksRegistry.collectFromFeature(feature);
    this.pushInspectorSnapshot();
  }

  /**
   * 在所有 Feature 工具注册完毕后、inspector snapshot 推送之前调用。
   * 子类可重写此方法注册额外工具（如统一代理工具覆盖同名 feature 工具）。
   */
  protected async onFeatureToolsReady(): Promise<void> {}

  /**
   * 收集所有 Feature 自带的 skills
   * 约定：Feature source 同级目录下存在 skills/ 目录则自动发现
   */
  private async collectFeatureSkills(): Promise<SkillMetadata[]> {
    const collected: SkillMetadata[] = [];

    for (const [name, feature] of this.features) {
      if (name === 'skill') continue;
      if (!feature.source) continue;

      const filePath = feature.source.startsWith('file://')
        ? fileURLToPath(feature.source) : feature.source;
      const skillsDir = join(dirname(filePath), 'skills');
      if (!existsSync(skillsDir)) continue;

      const found = await discover({ dir: skillsDir });
      if (found.length > 0) {
        collected.push(...found);
      }
    }

    return collected;
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
        stepSaveFn: this._createStepSaveFn(),
        peekContinuationRequest: () => this._continuationRequest,
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

  private createCallOutcome(
    result: import('./agent/types.js').ReActResult,
    startedAt: number,
  ): import('./lifecycle.js').CallOutcome {
    const status = result.completed
      ? 'completed'
      : result.finishReason === 'cancelled'
        ? 'cancelled'
        : result.finishReason === 'continued'
          ? 'continued'
          : 'failed';
    return {
      status,
      reason: result.finishReason,
      response: result.finalResponse,
      steps: result.turns,
      startedAt,
      finishedAt: Date.now(),
      ...(result.error ? { error: result.error } : {}),
      ...(result.model ? { model: result.model } : {}),
    };
  }

  private async captureRuntimeSnapshot(context?: Context, callIndexOverride?: number): Promise<AgentRuntimeSnapshot> {
    await this.ensureFeatureTools();
    return {
      initialized: this._initialized,
      callIndex: callIndexOverride ?? this._callIndex,
      context: context?.toJSON(),
      featureStates: captureFeatureSnapshots(this.features),
      usageStats: this.usageStats.toSnapshot(),
      ...(this._lastCallOutcome ? { lastCallOutcome: this._lastCallOutcome } : {}),
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

    // 恢复最近一次 Call 的结构化终态
    this._lastCallOutcome = snapshot.lastCallOutcome ?? null;
  }

  private commitCallCheckpoint(checkpoint: CallRollbackCheckpoint): void {
    this._callCheckpoints = this._callCheckpoints
      .filter(entry => entry.callIndex < checkpoint.callIndex)
      .concat(checkpoint);
  }

  /**
   * 将反序列化的 checkpoint entry 归一化为 v2 union 格式。
   *
   * - 有 `kind` 字段 → 已是 v2 格式，直接断言返回
   * - 无 `kind` 但有 `runtime` → v1 格式，尝试 lazy migration 转 boundary；
   *   无法安全转换的保留为 legacy-full-snapshot
   */
  private normalizeCheckpointEntry(entry: Record<string, unknown>): CallRollbackCheckpoint {
    if (entry.kind === 'context-boundary' || entry.kind === 'legacy-full-snapshot') {
      return entry as unknown as CallRollbackCheckpoint;
    }

    // v1 格式：{ callIndex, draftInput, runtime }
    const callIndex = typeof entry.callIndex === 'number' ? entry.callIndex : -1;
    const draftInput = typeof entry.draftInput === 'string' ? entry.draftInput : '';
    const runtime = entry.runtime as AgentRuntimeSnapshot | undefined;

    if (!runtime) {
      return {
        kind: 'legacy-full-snapshot',
        callIndex,
        draftInput,
        runtime: { initialized: false, callIndex, context: undefined, featureStates: [] },
        legacyReason: 'v1 entry missing runtime',
      };
    }

    // 尝试 lazy migration：如果 runtime.context.messages 是当前 Context 的前缀，
    // 转为 boundary；否则保留 legacy
    const context = this.persistentContext;
    const cpContext = runtime.context;
    const cpMessages = cpContext?.messages;
    if (context && cpContext && Array.isArray(cpMessages)) {
      const currentMessages = context.getAll();
      if (cpMessages.length <= currentMessages.length) {
        const currentGen = context.captureBoundary().generation;
        const enrichedLen = Array.isArray(cpContext.enrichedMessages)
          ? cpContext.enrichedMessages.length
          : cpMessages.length;
        return {
          kind: 'context-boundary',
          callIndex,
          draftInput,
          contextBoundary: {
            messagesLength: cpMessages.length,
            enrichedMessagesLength: enrichedLen,
            sequence: cpContext.sequence ?? enrichedLen,
            generation: currentGen,
          },
          runtimeState: {
            initialized: runtime.initialized,
            callIndex: runtime.callIndex,
            featureStates: runtime.featureStates ?? [],
            usageStats: runtime.usageStats,
          },
        };
      }
    }

    return {
      kind: 'legacy-full-snapshot',
      callIndex,
      draftInput,
      runtime,
      legacyReason: 'v1 checkpoint not a prefix of current context',
    };
  }

  /**
   * 捕获不含 Context 的运行态（用于增量 checkpoint）。
   */
  private async captureRuntimeStateWithoutContext(callIndexOverride?: number): Promise<RuntimeStateWithoutContext> {
    await this.ensureFeatureTools();
    return {
      initialized: this._initialized,
      callIndex: callIndexOverride ?? this._callIndex,
      featureStates: captureFeatureSnapshots(this.features),
      usageStats: this.usageStats.toSnapshot(),
      ...(this._lastCallOutcome ? { lastCallOutcome: this._lastCallOutcome } : {}),
    };
  }

  /**
   * 恢复不含 Context 的运行态（用于增量 rollback）。
   * 调用前应已通过 truncateToBoundary 截断 Context。
   */
  private async restoreRuntimeStateWithoutContext(state: RuntimeStateWithoutContext): Promise<void> {
    await restoreFeatureSnapshots(state.featureStates, this.features);
    this._initialized = state.initialized;
    this._callIndex = state.callIndex;
    this._currentStep = 0;
    if (state.usageStats) {
      this.usageStats.fromSnapshot(state.usageStats);
    }
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
      ...(typeof (this.llm as any)?.modelName === 'string'
        ? { modelName: (this.llm as any).modelName }
        : {}),
      ...(typeof this._llmMeta.presetName === 'string' && this._llmMeta.presetName
        ? { presetName: this._llmMeta.presetName }
        : {}),
      ...(this._llmMeta.thinkingEffort != null
        ? { thinkingEffort: this._llmMeta.thinkingEffort }
        : {}),
      ...(typeof this._llmMeta.contextLength === 'number' && this._llmMeta.contextLength > 0
        ? { contextLength: this._llmMeta.contextLength }
        : {}),
      ...(typeof this._llmMeta.compressRatio === 'number' && this._llmMeta.compressRatio > 0
        ? { compressRatio: this._llmMeta.compressRatio }
        : {}),
    };
  }

  private buildHookInspectorSnapshot(): HookInspectorSnapshot {
    const hookGroups = this.hooksRegistry.getSnapshot();
    const hookCountByFeature = new Map<string, number>();
    const toolEntriesBySource = new Map<string, Array<{
      name: string;
      description: string;
      state: 'enabled' | 'disabled' | 'removed' | 'superseded';
      enabled: boolean;
      renderCall?: string;
      renderResult?: string;
      source?: string;
      parameters?: Record<string, unknown>;
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
      const sourceKey = entry.source || '__no_source__';
      if (!toolEntriesBySource.has(sourceKey)) {
        toolEntriesBySource.set(sourceKey, []);
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

      toolEntriesBySource.get(sourceKey)!.push({
        name: entry.tool.name,
        description: summarizeToolDescription(entry.tool.description),
        state: entry.state,
        enabled: entry.state === 'enabled',
        renderCall,
        renderResult,
        source: entry.source,
        parameters: entry.tool.parameters,
      });
    }

    // 已知的 feature name 集合
    const featureNames = new Set(this.features.keys());

    const features = Array.from(this.features.values()).map(feature => {
      const tools = toolEntriesBySource.get(feature.name) || [];
      const enabledToolCount = tools.filter(tool => tool.state === 'enabled').length;
      const disabledToolCount = tools.filter(tool => tool.state === 'disabled').length;
      const removedToolCount = tools.filter(tool => tool.state === 'removed').length;
      const supersededToolCount = tools.filter(tool => tool.state === 'superseded').length;
      const activeToolCount = tools.length - supersededToolCount;
      const status: 'enabled' | 'disabled' | 'removed' | 'partial' = activeToolCount === 0
        ? 'enabled'
        : removedToolCount === activeToolCount
          ? 'removed'
          : disabledToolCount === activeToolCount
            ? 'disabled'
            : enabledToolCount === activeToolCount
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

    // 收集不属于任何 feature 的工具（游离工具）
    const standaloneTools: Array<{
      name: string;
      description: string;
      state: 'enabled' | 'disabled' | 'removed' | 'superseded';
      enabled?: boolean;
      source?: string;
      renderCall?: string;
      renderResult?: string;
      parameters?: Record<string, unknown>;
    }> = [];
    for (const [sourceKey, tools] of toolEntriesBySource) {
      if (!featureNames.has(sourceKey)) {
        for (const tool of tools) {
          standaloneTools.push(tool);
        }
      }
    }

    return {
      lifecycleOrder: hookGroups.map(group => group.lifecycle),
      features,
      hooks: hookGroups,
      standaloneTools: standaloneTools.length > 0 ? standaloneTools : undefined,
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

