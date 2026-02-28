/**
 * 编程小助手 Agent
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 继承 BasicAgent 获得所有基础设施能力
 */

import { BasicAgent } from '../src/agents/index.js';
import type { BasicAgentConfig } from '../src/agents/index.js';
import { TemplateComposer } from '../src/template/composer.js';
import { ContextFeature } from '../src/features/index.js';
import { TodoFeature } from '../src/features/index.js';
import type {
  AgentInitiateContext,
  TurnStartContext,
  TurnFinishedContext,
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
  /** 有待执行任务时的提醒间隔（默认：3 轮） */
  reminderThresholdWithTasks?: number;
  /** 无待执行任务时的提醒间隔（默认：6 轮） */
  reminderThresholdWithoutTasks?: number;
}

/**
 * 编程小助手 Agent
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 继承 BasicAgent 获得所有基础设施能力
 */
export class ProgrammingHelperAgent extends BasicAgent {
  private _todoFeature: TodoFeature;

  constructor(config?: ProgrammingHelperAgentConfig) {
    super(config);
    // 必须先注册 ContextFeature（TodoFeature 依赖它）
    this.use(new ContextFeature());
    // 注册 TodoFeature 并配置 reminder
    this._todoFeature = new TodoFeature({
      reminderTemplate: '.agentdev/prompts/reminder-update-todo.md',
      reminderThresholdWithTasks: config?.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config?.reminderThresholdWithoutTasks,
    });
    this.use(this._todoFeature);
  }

  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
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
  }

  protected override async onTurnStart(ctx: TurnStartContext): Promise<void> {
    // TodoFeature 在每轮开始时检查是否需要注入 reminder
    this._todoFeature.checkAndInjectReminder({
      context: ctx.context,
      callTurn: ctx.callTurn,
    });
  }

  protected override async onTurnFinished(ctx: TurnFinishedContext): Promise<HookResult | undefined> {
    // TodoFeature 记录本轮是否使用了 todo 工具
    const toolCalls = ctx.llmResponse.toolCalls ?? [];
    this._todoFeature.recordToolUsage(toolCalls);
    return undefined;
  }
}
