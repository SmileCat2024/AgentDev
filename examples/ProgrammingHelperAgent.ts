/**
 * 编程小助手 Agent
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 继承 BasicAgent 获得所有基础设施能力
 */

import { BasicAgent } from '../src/agents/index.js';
import type { BasicAgentConfig } from '../src/agents/index.js';
import { TemplateComposer } from '../src/template/composer.js';
import { AuditFeature, TodoFeature, VisualFeature, WebSearchFeature } from '../src/features/index.js';
import type { AgentInitiateContext } from '../src/core/lifecycle.js';

/**
 * 编程小助手配置选项
 */
export interface ProgrammingHelperAgentConfig extends BasicAgentConfig {
  /** Agent 显示名称（默认：'编程小助手'） */
  name?: string;
  /** MCP 配置名称（可选）；传 false 时禁用；不传时 BasicAgent 会自动扫描 .agentdev/mcps */
  mcpServer?: string | false;
  /** 有待执行任务时的提醒间隔（默认：3 轮） */
  reminderThresholdWithTasks?: number;
  /** 无待执行任务时的提醒间隔（默认：6 轮） */
  reminderThresholdWithoutTasks?: number;
}

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];

/**
 * 编程小助手 Agent
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 继承 BasicAgent 获得所有基础设施能力
 *
 * 设计说明：
 * - TodoFeature 通过反向钩子（@StepStart, @StepFinished）自动处理提醒逻辑
 * - 无需在此类中重写 onStepStart/onStepFinished
 */
export class ProgrammingHelperAgent extends BasicAgent {
  constructor(config?: ProgrammingHelperAgentConfig) {
    super({
      ...config,
      excludeMcpServers: Array.from(new Set([
        ...(config?.excludeMcpServers ?? []),
        ...DEFAULT_EXCLUDED_MCP_SERVERS,
      ])),
    });

    // 注册 TodoFeature 并配置 reminder
    // TodoFeature 会通过反向钩子自动处理：
    // - @StepStart: 检查并注入 reminder
    // - @StepFinished: 记录工具使用情况
    this.use(new TodoFeature({
      reminderTemplate: '.agentdev/prompts/reminder-update-todo.md',
      reminderThresholdWithTasks: config?.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config?.reminderThresholdWithoutTasks,
    }));

    this.use(new AuditFeature());

    // 注册 VisualFeature - 提供窗口截图和视觉理解能力
    // - onCallStart 钩子：每次对话开始时自动注入当前窗口状态
    // - capture_and_understand_window 工具：截图指定窗口并进行视觉理解
    this.use(new VisualFeature());
    this.use(new WebSearchFeature());

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
      .add('除了标准工具外，你还可以使用通过 MCP (Model Context Protocol) 接入的外部工具。默认自动挂载的工具通常以 `mcp_` 开头，而业务功能内部封装的工具可能使用业务前缀命名。\n')
      .add('\n\n## 视觉理解能力\n\n')
      .add('你可以使用 `capture_and_understand_window` 工具来截取指定窗口的截图，并使用视觉模型理解其内容。')
      .add('这个功能可以帮助你：')
      .add('\n- 查看和分析当前打开的窗口内容')
      .add('- 理解用户界面的状态和布局')
      .add('- 获取应用窗口的视觉信息')
      .add('\n\n## WebSearch 能力\n\n')
      .add('你可以使用 `web_fetch` 获取网页原始内容。')
      .add('如果内置 crawl4ai 服务可用，还可以使用以 `websearch_crawl4ai_` 开头的工具执行更强的网页抓取与提取。')
      .add('\n\n每次对话开始时，你会自动收到当前系统窗口状态的摘要信息。')
    );
  }
}
