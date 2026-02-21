/**
 * Agent - 组装所有组件
 * 提供简单的使用接口 - v3 重构版
 */

import type { AgentConfig, ToolCall, Tool } from './types.js';
import type { TemplateSource, PlaceholderContext } from '../template/types.js';
import type { SkillMetadata } from '../skills/types.js';
import { ToolRegistry } from './tool.js';
import { Context, ContextSnapshot } from './context.js';
import { DebugHub } from './debug-hub.js';
import type {
  ToolContext,
  ToolResult,
  HookResult,
  AgentInitiateContext,
  AgentDestroyContext,
  CallStartContext,
  CallFinishContext,
  TurnStartContext,
  TurnFinishedContext,
  LLMStartContext,
  LLMFinishContext,
  SubAgentSpawnContext,
  SubAgentUpdateContext,
  SubAgentDestroyContext,
} from './lifecycle.js';
import { TemplateComposer } from '../template/composer.js';
import { TemplateLoader } from '../template/loader.js';
import { existsSync } from 'fs';
import { cwd } from 'process';
import { MCPConnectionManager } from '../mcp/index.js';
import { MCPToolAdapter, createMCPToolAdapters } from '../mcp/index.js';
import { AgentPool } from './agent-pool.js';

// Re-export ContextSnapshot for convenience
export type { ContextSnapshot };

// ========== 错误处理策略枚举 ==========

/**
 * 钩子错误处理策略
 */
export enum HookErrorHandling {
  /** 静默失败：记录警告，不中断主流程 */
  Silent = 'silent',
  /** 传播异常：中断整个 onCall 流程 */
  Propagate = 'propagate',
  /** 记录后传播：先记录日志再抛出 */
  Logged = 'logged',
}

export class Agent {
  protected llm: AgentConfig['llm'];
  protected tools: ToolRegistry;
  protected maxTurns: number;
  protected systemMessage?: string | TemplateSource;
  protected systemContext?: PlaceholderContext;
  protected templateComposer?: TemplateComposer;
  protected templateLoader: TemplateLoader;
  protected persistentContext?: Context;
  protected debugHub?: DebugHub;
  protected agentId?: string;
  protected debugEnabled: boolean = false;
  protected skillsDir?: string;
  protected skills: SkillMetadata[] = [];
  protected skillsLoaded: boolean = false;

  // MCP 相关
  protected mcpConnectionManager?: MCPConnectionManager;
  protected mcpConfig?: AgentConfig['mcp'];
  protected mcpToolsRegistered: boolean = false;
  protected mcpContext?: Record<string, unknown>;

  // 子代理相关
  protected _pool?: AgentPool;

  /** 子代理的 ID（仅子代理有值） */
  protected _agentId?: string;
  /** 父代理的 AgentPool 引用（仅子代理有值） */
  protected _parentPool?: import('./agent-pool.js').AgentPool;

  // ========== 生命周期状态 ==========
  /** Agent 是否已初始化（onInitiate 只触发一次） */
  protected _initialized: boolean = false;
  /** 当前 onCall 的用户输入 */
  protected _currentCallInput?: string;
  /** 当前 ReAct 循环的轮次 */
  protected _currentTurn: number = 0;
  /** 记录每个 onCall 的开始时间（用于性能监控） */
  protected _callStartTimes: Map<number, number> = new Map();

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.maxTurns = config.maxTurns ?? 10;
    this.systemMessage = config.systemMessage;
    this.templateLoader = new TemplateLoader();
    this.tools = new ToolRegistry();

    // 如果 systemMessage 是 TemplateComposer，保存引用
    if (config.systemMessage instanceof TemplateComposer) {
      this.templateComposer = config.systemMessage;
    }

    // 注册工具
    if (config.tools) {
      for (const tool of config.tools) {
        this.tools.register(tool);
      }
    }

    // Skills 配置
    if (config.skillsDir) {
      this.skillsDir = config.skillsDir;
    }

    // MCP 配置（懒加载，不在构造函数中连接）
    if (config.mcp) {
      this.mcpConfig = config.mcp;
      this.mcpContext = config.mcpContext;
      // 注意：不在此时建立连接，采用懒加载策略
      // 连接将在首次调用 MCP 工具时建立
    }
  }

  // ========== 生命周期钩子辅助方法 ==========

  /**
   * 获取钩子的错误处理策略（可被子类覆盖）
   * @param hookName 钩子名称
   * @returns 错误处理策略
   */
  protected getHookErrorHandling(hookName: string): HookErrorHandling {
    // 默认策略：Call/LLM/Tool 级别的钩子传播异常，其他静默失败
    const propagateHooks = [
      'onCallStart', 'onCallFinish',
      'onLLMStart', 'onLLMFinish',
      'onToolUse', 'onToolFinished',
    ];
    return propagateHooks.includes(hookName) ? HookErrorHandling.Propagate : HookErrorHandling.Silent;
  }

  /**
   * 统一的钩子执行包装器（自动处理错误）
   */
  private async executeHook<T>(
    hookName: string,
    hookFn: () => Promise<T>,
    context: { input?: string; turn?: number }
  ): Promise<T | undefined> {
    try {
      return await hookFn();
    } catch (error) {
      const strategy = this.getHookErrorHandling(hookName);
      const errorMsg = error instanceof Error ? error.message : String(error);

      switch (strategy) {
        case HookErrorHandling.Silent:
          console.warn(`[Agent] Hook ${hookName} failed (silent):`, errorMsg);
          return undefined;

        case HookErrorHandling.Logged:
          console.error(`[Agent] Hook ${hookName} failed (logged):`, errorMsg);
          throw error;

        case HookErrorHandling.Propagate:
          throw error;

        default:
          return undefined;
      }
    }
  }

  // ========== 公开方法 ==========

  /**
   * 唯一的公开入口 - 执行 Agent
   *
   * 多次调用会自动复用上下文，实现"追问"效果
   *
   * @param input 用户输入
   * @returns Agent 响应内容
   */
  async onCall(input: string): Promise<string> {
    // 注册 MCP 工具（懒加载，首次调用时才连接）
    await this.registerMCPTools();

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

    this._currentCallInput = input;
    this._callStartTimes.set(callId, callStartTime);

    // 触发 onCallStart（使用 executeHook 包装器）
    await this.executeHook(
      'onCallStart',
      () => this.onCallStart({ input, context, isFirstCall }),
      { input }
    );

    try {
      // ========== Agent Initiate（仅首次）==========
      if (!this._initialized) {
        // 先触发 onInitiate，让子类有机会在加载系统消息前进行配置
        await this.executeHook(
          'onInitiate',
          () => this.onInitiate({ context }),
          { input }
        );

        // 加载系统提示词（onInitiate 中可能修改了 systemMessage）
        if (this.systemMessage && context.getAll().length === 0) {
          const systemMsg = await this.resolveSystemPrompt();
          if (systemMsg) {
            context.add({ role: 'system', content: systemMsg });
          }
        }

        // 添加用户输入
        context.add({ role: 'user', content: input });

        // 推送初始状态到 DebugHub
        if (this.debugEnabled && this.agentId && this.debugHub) {
          this.debugHub.pushMessages(this.agentId, context.getAll());
        }

        this._initialized = true;
      } else {
        // 非首次调用，直接添加用户输入
        context.add({ role: 'user', content: input });

        // 推送消息到 DebugHub
        if (this.debugEnabled && this.agentId && this.debugHub) {
          this.debugHub.pushMessages(this.agentId, context.getAll());
        }
      }

      // ========== ReAct 循环 ==========
      let completed = false;
      let finalResponse = '';

      for (let turn = 0; turn < this.maxTurns; turn++) {
        this._currentTurn = turn;

        // 推送消息到 DebugHub
        if (this.debugEnabled && this.agentId && this.debugHub) {
          this.debugHub.pushMessages(this.agentId, context.getAll());
        }

        // ========== Turn Start ==========
        await this.executeHook(
          'onTurnStart',
          () => this.onTurnStart({ turn, context, input }),
          { input, turn }
        );

        // ========== LLM Start ==========
        const llmStartResult = await this.executeHook(
          'onLLMStart',
          () => this.onLLMStart({
            messages: context.getAll(),
            tools: this.tools.getAll(),
            turn,
          }),
          { input, turn }
        );

        // 检查是否被阻止
        if (llmStartResult?.action === 'block') {
          // LLM 调用被阻止
          const blockResponse = llmStartResult.reason || 'LLM call blocked by hook';
          context.add({
            role: 'assistant',
            content: blockResponse,
          });

          // 跳出循环
          completed = true;
          finalResponse = blockResponse;
          break;
        }

        // 执行 LLM 调用
        const llmStartTime = Date.now();
        const response = await this.llm.chat(
          context.getAll(),
          this.tools.getAll()
        );
        const llmDuration = Date.now() - llmStartTime;

        // ========== LLM Finish ==========
        await this.executeHook(
          'onLLMFinish',
          () => this.onLLMFinish({ response, turn, duration: llmDuration }),
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
        if (this.debugEnabled && this.agentId && this.debugHub) {
          this.debugHub.pushMessages(this.agentId, context.getAll());
        }

        // 检查是否需要调用工具
        if (!response.toolCalls || response.toolCalls.length === 0) {
          // 检查是否有子代理在运行
          if (this._pool && this._pool.hasActiveAgents()) {
            // 等待子代理消息（5秒超时）
            const result = await this._pool.waitForMessage(5000);

            if (result) {
              // 收到消息，添加到上下文并继续循环
              // 使用 'assistant' 角色，在内容中标注子代理来源
              context.add({
                role: 'assistant',
                content: `[子代理 ${result.agentId} 执行完成]:\n\n${result.message}\n\n(子代理已完成任务，结果已接收，无需调用 list_agents 确认)`,
              });

              // 推送到 DebugHub
              if (this.debugEnabled && this.agentId && this.debugHub) {
                this.debugHub.pushMessages(this.agentId, context.getAll());
              }

              // 继续下一轮
              continue;
            }
            // 超时则结束循环
          }

          completed = true;
          finalResponse = response.content;

          // ========== Turn Finished（无工具调用）==========
          await this.executeHook(
            'onTurnFinished',
            () => this.onTurnFinished({
              turn,
              context,
              input,
              llmResponse: response,
              toolCallsCount: 0,
            }),
            { input, turn }
          );

          break;
        }

        // 执行工具
        for (const call of response.toolCalls) {
          await this.executeTool(call, input, context, turn);
        }

        // ========== Turn Finished（有工具调用）==========
        await this.executeHook(
          'onTurnFinished',
          () => this.onTurnFinished({
            turn,
            context,
            input,
            llmResponse: response,
            toolCallsCount: response.toolCalls?.length ?? 0,
          }),
          { input, turn }
        );
      }

      // 达到最大轮次
      if (!completed) {
        finalResponse = context.getAll()[context.getAll().length - 1]?.content || '';
      }

      // 保存上下文
      this.persistentContext = context;

      // ========== Call Finish（成功）==========
      await this.executeHook(
        'onCallFinish',
        () => this.onCallFinish({
          input,
          context,
          response: finalResponse,
          turns: this._currentTurn + 1,
          completed: true,
        }),
        { input }
      );

      return finalResponse;

    } catch (error) {
      // ========== Call Finish（异常）==========
      const errorMsg = error instanceof Error ? error.message : String(error);

      await this.executeHook(
        'onCallFinish',
        () => this.onCallFinish({
          input,
          context,
          response: errorMsg,
          turns: this._currentTurn + 1,
          completed: false,
        }),
        { input }
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
   * 启用可视化查看器（多 Agent 共享模式）
   *
   * @param name Agent 显示名称（可选，默认使用类名）
   * @param port HTTP 端口（默认 2026，仅在首次调用时生效）
   */
  async withViewer(name?: string, port?: number): Promise<this> {
    this.debugHub = DebugHub.getInstance();
    this.debugEnabled = true;

    // 首次调用时启动调试服务器
    if (!this.debugHub.getCurrentAgentId()) {
      await this.debugHub.start(port);
    }

    // 注册自身到 Hub
    this.agentId = this.debugHub.registerAgent(this, name || this.constructor.name);

    // 注册工具到 Hub
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
   * @param prompt 模板源（字符串、文件路径、或组合器）
   * @returns this，支持链式调用
   */
  setSystemPrompt(prompt: string | TemplateSource): this {
    if (typeof prompt === 'string') {
      this.systemMessage = prompt;
      this.templateComposer = undefined;
    } else if (prompt instanceof TemplateComposer) {
      this.systemMessage = prompt;
      this.templateComposer = prompt;
    } else {
      // { file: string }
      this.systemMessage = prompt;
      this.templateComposer = undefined;
    }
    return this;
  }

  /**
   * 设置占位符上下文变量
   * @param context 占位符键值对
   * @returns this，支持链式调用
   */
  setSystemContext(context: PlaceholderContext): this {
    this.systemContext = context;
    return this;
  }

  /**
   * 解析系统提示词（渲染模板）
   * @returns 渲染后的系统提示词字符串
   */
  private async resolveSystemPrompt(): Promise<string> {
    // 加载 skills（如果配置了且未加载）
    if (this.skillsDir && !this.skillsLoaded) {
      const { discover } = await import('../skills/loader.js');
      this.skills = await discover({ dir: this.skillsDir });
      this.skillsLoaded = true;
    }

    // 使用用户设置的上下文，并注入 skills
    const context: PlaceholderContext = {
      ...this.systemContext,
      skills: this.skills as any,
    };

    // 直接字符串
    if (typeof this.systemMessage === 'string') {
      const { PlaceholderResolver } = await import('../template/resolver.js');
      return PlaceholderResolver.resolve(this.systemMessage, context);
    }

    // TemplateComposer 实例
    if (this.templateComposer) {
      const result = await this.templateComposer.render(context);
      return result.content;
    }

    // 文件路径 { file: string }
    if (this.systemMessage && typeof this.systemMessage === 'object' && 'file' in this.systemMessage) {
      const content = await this.templateLoader.load(this.systemMessage.file);
      const { PlaceholderResolver } = await import('../template/resolver.js');
      return PlaceholderResolver.resolve(content, context);
    }

    return '';
  }

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

  // ========== 可重载的生命周期钩子 ==========

  // ========== Agent 级别钩子 ==========

  /**
   * Agent 初始化钩子
   * 只在首次 onCall 时触发一次
   */
  protected async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    // 默认空实现
  }

  /**
   * Agent 销毁钩子
   * 通过 dispose() 方法触发
   */
  protected async onDestroy(ctx: AgentDestroyContext): Promise<void> {
    // 默认空实现
  }

  // ========== Call 级别钩子 ==========

  /**
   * 每次 onCall 开始时触发
   */
  protected async onCallStart(ctx: CallStartContext): Promise<void> {
    // 默认空实现
  }

  /**
   * 每次 onCall 结束时触发
   */
  protected async onCallFinish(ctx: CallFinishContext): Promise<void> {
    // 默认空实现
  }

  // ========== Turn 级别钩子 ==========

  /**
   * 每轮 ReAct 循环开始时触发
   */
  protected async onTurnStart(ctx: TurnStartContext): Promise<void> {
    // 默认空实现
  }

  /**
   * 每轮 ReAct 循环结束时触发
   */
  protected async onTurnFinished(ctx: TurnFinishedContext): Promise<void> {
    // 默认空实现
  }

  // ========== LLM 级别钩子 ==========

  /**
   * 每次 LLM 调用前触发
   * 可以通过返回 { action: 'block' } 阻止调用
   */
  protected async onLLMStart(ctx: LLMStartContext): Promise<HookResult | undefined> {
    return undefined;
  }

  /**
   * 每次 LLM 调用后触发
   */
  protected async onLLMFinish(ctx: LLMFinishContext): Promise<void> {
    // 默认空实现
  }

  // ========== Tool 级别钩子（重命名）==========

  /**
   * 工具使用前钩子（原 onPreToolUse）
   *
   * 返回值规则：
   * - { action: 'block' }  → 阻止工具执行
   * - { action: 'allow' }  → 允许工具执行
   * - undefined              → 默认行为（一律放行）
   *
   * @param ctx 工具上下文
   * @returns 钩子结果
   */
  protected async onToolUse(ctx: ToolContext): Promise<HookResult | undefined> {
    return undefined;
  }

  /**
   * 工具执行后钩子（原 onPostToolUse）
   *
   * @param result 工具执行结果
   */
  protected async onToolFinished(result: ToolResult): Promise<void> {
    // 默认空实现
  }

  // ========== 向后兼容别名（废弃）==========

  /**
   * @deprecated 使用 onToolUse 代替
   */
  protected async onPreToolUse(ctx: ToolContext): Promise<HookResult | undefined> {
    return this.onToolUse(ctx);
  }

  /**
   * @deprecated 使用 onToolFinished 代替
   */
  protected async onPostToolUse(result: ToolResult): Promise<void> {
    return this.onToolFinished(result);
  }

  // ========== SubAgent 级别钩子 ==========

  /**
   * 子代理创建钩子
   */
  public async onSubAgentSpawn(ctx: SubAgentSpawnContext): Promise<void> {
    // 默认空实现
  }

  /**
   * 子代理状态更新钩子
   */
  public async onSubAgentUpdate(ctx: SubAgentUpdateContext): Promise<void> {
    // 默认空实现
  }

  /**
   * 子代理销毁钩子
   */
  public async onSubAgentDestroy(ctx: SubAgentDestroyContext): Promise<void> {
    // 默认空实现
  }

  // ========== 子代理管理 ==========

  /**
   * 子代理向父代理回传消息
   * @param message 消息内容
   */
  protected async reportToParent(message: string): Promise<void> {
    if (!this._parentPool || !this._agentId) {
      return; // 不是子代理，忽略
    }
    await this._parentPool.report(this._agentId, message);
  }

  /**
   * 获取子代理池
   */
  public get pool(): AgentPool {
    if (!this._pool) {
      this._pool = new AgentPool(this);
    }
    return this._pool;
  }

  /**
   * 创建 Agent 实例（子类可覆盖）
   * 异步方法，因为需要使用动态 import()
   */
  public async createAgentByType(type: string): Promise<Agent> {
    // 支持的 Agent 类型
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
          tools: this.tools.getAll().slice(0, 3), // 简化工具集
        });
      }
    }
  }

  // ========== MCP 集成 ==========

  /**
   * 注册 MCP 工具（懒加载）
   *
   * 首次调用时才建立连接并注册工具
   */
  protected async registerMCPTools(): Promise<void> {
    console.log('[MCP] registerMCPTools called');
    console.log('[MCP] mcpConfig:', JSON.stringify(this.mcpConfig, null, 2));
    console.log('[MCP] mcpToolsRegistered:', this.mcpToolsRegistered);

    // 已经注册过，跳过
    if (this.mcpToolsRegistered || !this.mcpConfig) {
      console.log('[MCP] Skipping: already registered or no config');
      return;
    }

    try {
      // 创建连接管理器
      this.mcpConnectionManager = new MCPConnectionManager();
      const mcpManager = this.mcpConnectionManager; // 保存到局部变量
      let registeredCount = 0;

      // 遍历配置的 MCP 服务器
      for (const [serverId, serverConfig] of Object.entries(this.mcpConfig.servers)) {
        try {
          // 连接到服务器
          const mcpServer = await mcpManager.connectServer(
            serverId,
            serverConfig
          );

          // 获取服务器的工具列表
          const tools = await mcpManager.listTools(serverId);
          console.log(`[MCP] Server "${serverId}" provides ${tools.length} tools:`, tools.map(t => t.name || '(unnamed)').join(', '));

          // 为每个工具创建适配器并注册
          for (const tool of tools) {
            // 添加服务器前缀：mcp.serverId:toolName
            // 确保 tool.name 存在
            if (!tool.name) {
              console.warn(`[MCP] Skipping tool without name:`, tool);
              continue;
            }

            // 调试：打印 inputSchema 的结构（仅前 3 个工具）
            if (registeredCount < 3) {
              console.log(`[MCP] Tool "${tool.name}" inputSchema:`, JSON.stringify(tool.inputSchema, null, 2));
            }

            const originalToolName = tool.name; // 保存到局部变量以便闭包使用
            const toolName = `mcp.${serverId}:${originalToolName}`;

            const adaptedTool = new MCPToolAdapter({
              name: toolName,
              description: tool.description || `MCP tool: ${originalToolName}`,
              inputSchema: tool.inputSchema,
              enabled: true,
              handler: async (args: any) => {
                // 调用 MCP 工具 (参数顺序: name, serverName, args)
                return await mcpManager.callTool(
                  originalToolName,  // 工具名称
                  serverId,        // 服务器名称
                  args              // 工具参数
                );
              },
            }, { serverName: serverId });

            // 注册到工具注册表
            this.tools.register(adaptedTool);
            registeredCount++;
            console.log(`[MCP] Registered tool: ${toolName}`);
          }

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`[MCP] Failed to register tools from "${serverId}": ${errorMsg}`);
          // 继续处理其他服务器
        }
      }

      this.mcpToolsRegistered = true;
      console.log(`[MCP] Total registered tools: ${registeredCount}`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[MCP] Failed to register MCP tools: ${errorMsg}`);
    }
  }

  /**
   * 清理 MCP 连接
   */
  protected async disposeMCP(): Promise<void> {
    if (this.mcpConnectionManager) {
      await this.mcpConnectionManager.dispose();
    }
  }

  // ========== 内部实现 ==========

  /**
   * 执行单个工具
   */
  private async executeTool(
    call: ToolCall,
    input: string,
    context: Context,
    turn: number
  ): Promise<void> {
    const tool = this.tools.get(call.name);
    const startTime = Date.now();

    const toolCtx: ToolContext = {
      call,
      tool: tool!,
      turn,
      input,
      context,
    };

    // 前置钩子（使用 executeHook 包装器）
    let blocked = false;
    let blockReason: string | undefined;

    const hookResult = await this.executeHook(
      'onToolUse',
      () => this.onToolUse(toolCtx),
      { input, turn }
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
      turn,
      input,
      context,
    };

    if (blocked || !tool) {
      // 添加阻止结果到上下文
      // 格式：{ success: false, result: { error: string } }
      context.add({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({
          success: false,
          result: { error: result.error || 'Tool not found' },
        }),
      });
      await this.executeHook(
        'onToolFinished',
        () => this.onToolFinished(result),
        { input, turn }
      );
      return;
    }

    try {
      // 执行工具
      // 为 invoke_skill 注入 skills 上下文
      // 为 MCP 工具注入 mcpContext 上下文
      // 为 spawn_agent 注入父代理引用
      let toolContext: any = undefined;

      if (call.name === 'invoke_skill') {
        toolContext = { _context: { skills: this.skills } };
      } else if (call.name.startsWith('mcp.')) {
        // MCP 工具注入 mcpContext
        toolContext = { _mcpContext: this.mcpContext };
      } else if (['spawn_agent', 'list_agents', 'send_to_agent', 'close_agent'].includes(call.name)) {
        // 子代理管理工具注入父代理引用
        toolContext = { parentAgent: this };
      }

      const data = await tool.execute(call.arguments, toolContext);
      result.success = true;
      result.data = data;

      // 添加工具结果到上下文
      // 统一使用 JSON 格式，保持与错误处理的一致性
      // 注意：这里只对非字符串类型进行 JSON.stringify，避免双重编码
      const resultData = typeof data === 'string' ? data : JSON.stringify(data);
      context.add({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({
          success: true,
          result: resultData,
        }),
      });

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);

      // 添加错误结果到上下文（让 LLM 知道工具执行失败）
      // 格式：{ success: false, result: { error: string } }
      context.add({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({
          success: false,
          result: { error: result.error },
        }),
      });
    }

    result.duration = Date.now() - startTime;

    // 后置钩子（使用 executeHook 包装器）
    await this.executeHook(
      'onToolFinished',
      () => this.onToolFinished(result),
      { input, turn }
    );
  }

  /**
   * 清理资源（包括 MCP 连接）
   */
  async dispose(): Promise<void> {
    // 先清理子代理池
    await this._pool?.shutdown();

    // 触发 onDestroy 钩子
    const context = this.persistentContext ?? new Context();

    try {
      await this.executeHook(
        'onDestroy',
        () => this.onDestroy({ context }),
        {}
      );
    } catch (error) {
      console.warn('[Agent] onDestroy hook error:', error);
    }

    // 清理 MCP 连接
    await this.disposeMCP();

    // 注销 DebugHub
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.unregisterAgent(this.agentId);
    }

    // 重置状态
    this._initialized = false;
    this.persistentContext = undefined;
  }
}
