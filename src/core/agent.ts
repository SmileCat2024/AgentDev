/**
 * Agent - 组装所有组件
 * 提供简单的使用接口 - v3 重构版
 */

import type { AgentConfig, ToolCall, Tool } from './types.js';
import { ToolRegistry } from './tool.js';
import { Context, ContextSnapshot } from './context.js';
import { DebugHub } from './debug-hub.js';
import { ToolContext, ToolResult, HookResult } from './lifecycle.js';

// Re-export ContextSnapshot for convenience
export type { ContextSnapshot };

export class Agent {
  protected llm: AgentConfig['llm'];
  protected tools: ToolRegistry;
  protected maxTurns: number;
  protected systemMessage?: string;
  protected persistentContext?: Context;
  protected debugHub?: DebugHub;
  protected agentId?: string;
  protected debugEnabled: boolean = false;

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.maxTurns = config.maxTurns ?? 10;
    this.systemMessage = config.systemMessage;
    this.tools = new ToolRegistry();

    // 注册工具
    if (config.tools) {
      for (const tool of config.tools) {
        this.tools.register(tool);
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
    // 使用持久化上下文或创建新的
    const context = this.persistentContext ?? new Context();

    // 添加系统消息（如果是新上下文）
    if (this.systemMessage && context.getAll().length === 0) {
      context.add({ role: 'system', content: this.systemMessage });
    }

    // 添加用户输入
    context.add({ role: 'user', content: input });

    // 推送初始状态到 DebugHub（包含当前输入）
    if (this.debugEnabled && this.agentId && this.debugHub) {
      this.debugHub.pushMessages(this.agentId, context.getAll());
    }

    // ReAct 循环
    for (let turn = 0; turn < this.maxTurns; turn++) {
      // 推送消息到 DebugHub
      if (this.debugEnabled && this.agentId && this.debugHub) {
        this.debugHub.pushMessages(this.agentId, context.getAll());
      }

      // LLM 调用
      const response = await this.llm.chat(
        context.getAll(),
        this.tools.getAll()
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
        // 保存上下文并返回
        this.persistentContext = context;
        return response.content;
      }

      // 执行工具
      for (const call of response.toolCalls) {
        await this.executeTool(call, input, context, turn);
      }
    }

    // 达到最大轮次
    this.persistentContext = context;
    return context.getAll()[context.getAll().length - 1]?.content || '';
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

  /**
   * 获取上下文（用于调试，向后兼容）
   */
  getContext(): Context {
    return this.persistentContext ?? new Context();
  }

  /**
   * 获取工具列表（向后兼容）
   */
  getTools() {
    return this.tools;
  }

  // ========== 可重载的生命周期钩子 ==========

  /**
   * 工具调用前钩子
   *
   * 返回值规则：
   * - { action: 'block' }  → 阻止工具执行
   * - { action: 'allow' }  → 允许工具执行
   * - undefined              → 默认行为（一律放行）
   *
   * @param ctx 工具上下文
   * @returns 钩子结果
   */
  protected async onPreToolUse(ctx: ToolContext): Promise<HookResult | undefined> {
    return undefined;
  }

  /**
   * 工具执行后钩子
   *
   * @param result 工具执行结果
   */
  protected async onPostToolUse(result: ToolResult): Promise<void> {
    // 默认空实现
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

    // 前置钩子
    let blocked = false;
    let blockReason: string | undefined;

    const hookResult = await this.onPreToolUse(toolCtx);
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
      context.add({
        role: 'tool',
        toolCallId: call.id,
        content: result.error || 'Tool not found',
      });
      await this.onPostToolUse(result);
      return;
    }

    try {
      // 执行工具
      const data = await tool.execute(call.arguments);
      result.success = true;
      result.data = data;

      // 添加工具结果到上下文
      context.add({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(data),
      });

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);

      // 添加错误结果到上下文（让 LLM 知道工具执行失败）
      context.add({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({
          error: result.error,
          success: false,
        }),
      });
    }

    result.duration = Date.now() - startTime;

    // 后置钩子
    await this.onPostToolUse(result);
  }
}
