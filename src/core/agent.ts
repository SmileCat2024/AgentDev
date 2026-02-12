/**
 * Agent - 组装所有组件
 * 提供简单的使用接口 - v3 重构版
 */

import type { AgentConfig, ToolCall, Tool } from './types.js';
import { ToolRegistry } from './tool.js';
import { Context, ContextSnapshot } from './context.js';
import { MessageViewer } from './viewer.js';
import { ToolContext, ToolResult, HookResult } from './lifecycle.js';

// Re-export ContextSnapshot for convenience
export type { ContextSnapshot };

export class Agent {
  protected llm: AgentConfig['llm'];
  protected tools: ToolRegistry;
  protected maxTurns: number;
  protected systemMessage?: string;
  protected viewer?: MessageViewer;
  protected persistentContext?: Context;

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

    // 推送初始状态到 Viewer（包含当前输入）
    if (this.viewer) {
      this.viewer.push(context.getAll());
    }

    // ReAct 循环
    for (let turn = 0; turn < this.maxTurns; turn++) {
      // 推送消息到 Viewer
      if (this.viewer) {
        this.viewer.push(context.getAll());
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

      // 推送消息到 Viewer
      if (this.viewer) {
        this.viewer.push(context.getAll());
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
   * 启用调试
   */
  async withDebug(name: string): Promise<this> {
    // TODO: 实现调试注册逻辑
    return this;
  }

  /**
   * 启用可视化查看器（向后兼容）
   */
  async withViewer(port?: number): Promise<this> {
    this.viewer = new MessageViewer(port);
    await this.viewer.start();
    // 注册工具到viewer，用于渲染配置
    this.viewer.registerTools(this.tools.getAll());
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
    }

    result.duration = Date.now() - startTime;

    // 后置钩子
    await this.onPostToolUse(result);
  }
}
