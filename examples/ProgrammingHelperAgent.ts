/**
 * 编程小助手 Agent
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 继承 BasicAgent 获得所有基础设施能力
 */

import { BasicAgent } from '../src/agents/index.js';
import type { BasicAgentConfig } from '../src/agents/index.js';
import { TemplateComposer } from '../src/template/composer.js';
import { TodoFeature } from '../src/features/todo.js';
import type {
  AgentInitiateContext,
  AgentDestroyContext,
  CallStartContext,
  CallFinishContext,
  TurnStartContext,
  TurnFinishedContext,
  LLMStartContext,
  LLMFinishContext,
  ToolContext,
  ToolResult,
  HookResult,
} from '../src/core/lifecycle.js';

/**
 * 编程小助手配置选项
 */
export interface ProgrammingHelperAgentConfig extends BasicAgentConfig {
  /** Agent 显示名称（默认：'编程小助手'） */
  name?: string;
  /** MCP 服务器名称（可选） */
  mcpServer?: string;
}

/**
 * 编程小助手 Agent
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 继承 BasicAgent 获得所有基础设施能力
 */
export class ProgrammingHelperAgent extends BasicAgent {
  private _callCount = 0;

  constructor(config?: ProgrammingHelperAgentConfig) {
    super(config);
    // 添加 TodoFeature 用于任务管理
    this.use(new TodoFeature());
  }

  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    console.log('[Lifecycle] onInitiate 触发 - Agent 初始化（仅首次）');

    // 先调用父类的 onInitiate
    await super.onInitiate(ctx);

    // 配置专门的编程助手提示词
    this.setSystemPrompt(new TemplateComposer()
      .add({ file: '.agentdev/prompts/system.md' })
      .add('\n\n## 身份设定\n\n')
      .add('你是一个专业的编程助手，擅长代码编写、调试和优化。')
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你拥有如下技能，可使用 invoke_skill 工具激活，以展开技能的详细介绍。\n')
      .add({ skills: '- **{{name}}**: {{description}}' })
      .add('\n\n## MCP 工具\n\n')
      .add('除了标准工具外，你还可以使用 MCP (Model Context Protocol) 工具。MCP 工具的名称以 "mcp_" 开头。这些工具提供了与外部服务集成的能力。\n')
    );

    const mcpServer = this.getMcpServer();
    if (mcpServer) {
      console.log(`[Lifecycle] 已配置 ${mcpServer} MCP 服务器`);
      console.log('[Lifecycle] 可用工具将在首次调用时自动注册');
    } else {
      console.log('[Lifecycle] 未配置 MCP 服务器，将使用基础工具集');
    }

    console.log('[Lifecycle] onInitiate 完成');
  }

  protected override async onDestroy(ctx: AgentDestroyContext): Promise<void> {
    console.log('[Lifecycle] onDestroy 触发 - Agent 销毁');
  }

  protected override async onCallStart(ctx: CallStartContext): Promise<void> {
    this._callCount++;
    console.log(`[Lifecycle] onCallStart 触发 - 第 ${this._callCount} 次 onCall (isFirst: ${ctx.isFirstCall})`);
    console.log(`[Lifecycle]   用户输入: ${ctx.input.substring(0, 50)}${ctx.input.length > 50 ? '...' : ''}`);
  }

  protected override async onCallFinish(ctx: CallFinishContext): Promise<void> {
    console.log(`[Lifecycle] onCallFinish 触发 - 耗时 ${ctx.turns} 轮, 完成: ${ctx.completed}`);
    console.log(`[Lifecycle]   响应: ${ctx.response.substring(0, 100)}${ctx.response.length > 100 ? '...' : ''}`);
  }

  protected override async onTurnStart(ctx: TurnStartContext): Promise<void> {
    console.log(`[Lifecycle] onTurnStart 触发 - 第 ${ctx.turn + 1} 轮`);
  }

  protected override async onTurnFinished(ctx: TurnFinishedContext): Promise<HookResult | undefined> {
    console.log(`[Lifecycle] onTurnFinished 触发 - 第 ${ctx.turn + 1} 轮结束, 工具调用数: ${ctx.toolCallsCount}`);
    // 返回 undefined 使用默认行为（父类会自动处理 SubAgentFeature 集成）
    return undefined;
  }

  protected override async onLLMStart(ctx: LLMStartContext): Promise<HookResult | undefined> {
    console.log(`[Lifecycle] onLLMStart 触发 - 第 ${ctx.turn + 1} 轮, 消息数: ${ctx.messages.length}, 工具数: ${ctx.tools.length}`);
    return undefined;
  }

  protected override async onLLMFinish(ctx: LLMFinishContext): Promise<HookResult | undefined> {
    const hasToolCalls = ctx.response.toolCalls && ctx.response.toolCalls.length > 0;
    console.log(`[Lifecycle] onLLMFinish 触发 - 第 ${ctx.turn + 1} 轮, 耗时: ${ctx.duration}ms, 有工具调用: ${hasToolCalls}`);
    if (hasToolCalls) {
      console.log(`[Lifecycle]   工具调用: ${ctx.response.toolCalls!.map(t => t.name).join(', ')}`);
    }
    // 返回 undefined 使用默认行为（父类会自动处理 SubAgentFeature 集成）
    return undefined;
  }

  protected override async onToolUse(ctx: ToolContext): Promise<HookResult | undefined> {
    console.log(`[Lifecycle] onToolUse 触发 - 工具: ${ctx.call.name}`);
    console.log(`[Lifecycle]   参数: ${JSON.stringify(ctx.call.arguments).substring(0, 100)}...`);
    return undefined;
  }

  protected override async onToolFinished(result: ToolResult): Promise<void> {
    const status = result.success ? '成功' : '失败';
    console.log(`[Lifecycle] onToolFinished 触发 - 工具: ${result.call.name}, 状态: ${status}, 耗时: ${result.duration}ms`);
    if (!result.success) {
      console.log(`[Lifecycle]   错误: ${result.error}`);
    }
  }
}
