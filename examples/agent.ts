import { BasicAgent, TemplateComposer } from '../src/index.js';
import { exec } from 'child_process';
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
  SubAgentSpawnContext,
  SubAgentUpdateContext,
  SubAgentDestroyContext,
} from '../src/core/lifecycle.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { cwd } from 'process';

/**
 * 异步执行 agenthook 命令并获取用户输入
 */
function agentHook(agentId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`npx agenthook ${agentId}`, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout.trim());
    });
  });
}

/**
 * 加载 MCP 配置
 */
function loadMCPConfig(serverName: string): any {
  try {
    const configPath = join(cwd(), '.agentdev', 'mcps', `${serverName}.json`);
    if (!existsSync(configPath)) {
      return undefined;
    }
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * 编程小助手 Agent
 *
 * 继承 BasicAgent，配置默认的编程助手行为
 * 不传任何参数即可使用，默认加载配置文件
 *
 * 添加了完整生命周期日志输出，用于调试和验证
 */
class ProgrammingHelperAgent extends BasicAgent {
  private _callCount = 0;

  constructor(config?: { name?: string; mcpServer?: string }) {
    // 自动检测并加载 MCP 配置
    const mcpServer = config?.mcpServer ?? (loadMCPConfig('github') ? 'github' : undefined);

    super({
      name: config?.name ?? '编程小助手',
      mcpServer,
      mcpContext: {
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      },
    });
    console.log('[Lifecycle] ProgrammingHelperAgent 构造完成');
  }

  // ========== Agent 级别钩子 ==========

  protected async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    console.log('[Lifecycle] onInitiate 触发 - Agent 初始化（仅首次）');

    // 先加载 LLM（如果需要）
    await this.loadLLMIfNeeded();

    // 配置系统提示词
    this.setSystemPrompt(new TemplateComposer()
      .add({ file: '.agentdev/prompts/system.md' })
      .add('\n\n## 身份设定\n\n')
      .add('你是一个专业的编程助手，擅长代码编写、调试和优化。')
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你拥有如下技能，可使用 invoke_skill 工具激活，以展开技能的详细介绍。\n')
      .add({ skills: '- **{{name}}**: {{description}}' })
      .add('\n\n## MCP 工具\n\n')
      .add('除了标准工具外，你还可以使用 MCP (Model Context Protocol) 工具。MCP 工具的名称以 "mcp." 开头，例如 "mcp.github:create_issue"。这些工具提供了与外部服务集成的能力。\n')
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

  protected async onDestroy(ctx: AgentDestroyContext): Promise<void> {
    console.log('[Lifecycle] onDestroy 触发 - Agent 销毁');
  }

  // ========== Call 级别钩子 ==========

  protected async onCallStart(ctx: CallStartContext): Promise<void> {
    this._callCount++;
    console.log(`[Lifecycle] onCallStart 触发 - 第 ${this._callCount} 次 onCall (isFirst: ${ctx.isFirstCall})`);
    console.log(`[Lifecycle]   用户输入: ${ctx.input.substring(0, 50)}${ctx.input.length > 50 ? '...' : ''}`);
  }

  protected async onCallFinish(ctx: CallFinishContext): Promise<void> {
    console.log(`[Lifecycle] onCallFinish 触发 - 耗时 ${ctx.turns} 轮, 完成: ${ctx.completed}`);
    console.log(`[Lifecycle]   响应: ${ctx.response.substring(0, 100)}${ctx.response.length > 100 ? '...' : ''}`);
  }

  // ========== Turn 级别钩子 ==========

  protected async onTurnStart(ctx: TurnStartContext): Promise<void> {
    console.log(`[Lifecycle] onTurnStart 触发 - 第 ${ctx.turn + 1} 轮`);
  }

  protected async onTurnFinished(ctx: TurnFinishedContext): Promise<void> {
    console.log(`[Lifecycle] onTurnFinished 触发 - 第 ${ctx.turn + 1} 轮结束, 工具调用数: ${ctx.toolCallsCount}`);
  }

  // ========== LLM 级别钩子 ==========

  protected async onLLMStart(ctx: LLMStartContext): Promise<HookResult | undefined> {
    console.log(`[Lifecycle] onLLMStart 触发 - 第 ${ctx.turn + 1} 轮, 消息数: ${ctx.messages.length}, 工具数: ${ctx.tools.length}`);
    return undefined; // 允许执行
  }

  protected async onLLMFinish(ctx: LLMFinishContext): Promise<void> {
    const hasToolCalls = ctx.response.toolCalls && ctx.response.toolCalls.length > 0;
    console.log(`[Lifecycle] onLLMFinish 触发 - 第 ${ctx.turn + 1} 轮, 耗时: ${ctx.duration}ms, 有工具调用: ${hasToolCalls}`);
    if (hasToolCalls) {
      console.log(`[Lifecycle]   工具调用: ${ctx.response.toolCalls!.map(t => t.name).join(', ')}`);
    }
  }

  // ========== Tool 级别钩子 ==========

  protected async onToolUse(ctx: ToolContext): Promise<HookResult | undefined> {
    console.log(`[Lifecycle] onToolUse 触发 - 工具: ${ctx.call.name}`);
    console.log(`[Lifecycle]   参数: ${JSON.stringify(ctx.call.arguments).substring(0, 100)}...`);
    return undefined; // 允许执行
  }

  protected async onToolFinished(result: ToolResult): Promise<void> {
    const status = result.success ? '成功' : '失败';
    console.log(`[Lifecycle] onToolFinished 触发 - 工具: ${result.call.name}, 状态: ${status}, 耗时: ${result.duration}ms`);
    if (!result.success) {
      console.log(`[Lifecycle]   错误: ${result.error}`);
    }
  }

  // ========== SubAgent 级别钩子 ==========

  public override async onSubAgentSpawn(ctx: SubAgentSpawnContext): Promise<void> {
    console.log(`[Lifecycle] onSubAgentSpawn 触发 - 子代理 ID: ${ctx.agentId}, 类型: ${ctx.type}`);
    console.log(`[Lifecycle]   初始指令: ${ctx.instruction.substring(0, 50)}...`);
  }

  public override async onSubAgentUpdate(ctx: SubAgentUpdateContext): Promise<void> {
    console.log(`[Lifecycle] onSubAgentUpdate 触发 - 子代理: ${ctx.agentId}`);
    console.log(`[Lifecycle]   状态: ${ctx.oldStatus} -> ${ctx.newStatus}`);
    if (ctx.result) {
      console.log(`[Lifecycle]   结果长度: ${ctx.result.length} 字符 (已传送到主代理)`);
    }
    if (ctx.error) {
      console.log(`[Lifecycle]   错误: ${ctx.error}`);
    }
  }

  public override async onSubAgentDestroy(ctx: SubAgentDestroyContext): Promise<void> {
    console.log(`[Lifecycle] onSubAgentDestroy 触发 - 子代理: ${ctx.agentId}, 原因: ${ctx.reason}`);
  }
}

async function main() {
  const programmingAgent = new ProgrammingHelperAgent();

  await programmingAgent.withViewer('编程小助手', 2026);
  console.log('调试页面: http://localhost:2026\n');

  // 交互循环
  while (true) {
    const input = await agentHook('编程小助手');
    if (input === 'exit') break;
    if (!input) continue;
    console.log(`\n[编程小助手] > ${input}\n---`);
    const result = await programmingAgent.onCall(input);
    console.log(`结果: ${result}\n`);
  }

  // 清理资源
  await programmingAgent.dispose();
  console.log('[Lifecycle] 程序退出');
}

main().catch(console.error);
