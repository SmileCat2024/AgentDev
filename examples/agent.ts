import { BasicAgent, TemplateComposer } from '../src/index.js';
import { exec } from 'child_process';
import type { AgentInitiateContext } from '../src/core/lifecycle.js';
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
 */
class ProgrammingHelperAgent extends BasicAgent {
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
  }

  protected async onInitiate(ctx: AgentInitiateContext): Promise<void> {
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
      console.log(`[MCP] 已配置 ${mcpServer} MCP 服务器`);
      console.log('[MCP] 可用工具将在首次调用时自动注册');
    } else {
      console.log('[MCP] 未配置 MCP 服务器，将使用基础工具集');
    }
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
}

main().catch(console.error);
