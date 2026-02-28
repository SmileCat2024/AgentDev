import { Agent, createOpenAILLM, loadConfig, loadSystemTools, loadUserTools, TemplateComposer, SkillFeature, MCPFeature } from '../src/index.js';
import type { MCPConfig } from '../src/mcp/types.js';
import { exec } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { cwd, platform } from 'process';
import { join } from 'path';

/**
 * 加载 MCP 配置（从 .agentdev/mcps 目录）
 */
function loadMCPConfig(serverName: string): MCPConfig | undefined {
  try {
    const configPath = join(cwd(), '.agentdev', 'mcps', `${serverName}.json`);
    if (!existsSync(configPath)) {
      console.warn(`MCP config not found: ${configPath}`);
      return undefined;
    }
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Failed to load MCP config for ${serverName}:`, error);
    return undefined;
  }
}

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

async function main() {
  const config = await loadConfig();
  const llm = createOpenAILLM(config);

  // ========== 获取系统环境信息 ==========
  const systemContext = {
    SYSTEM_WORKING_DIR: cwd(),
    SYSTEM_IS_GIT_REPOSITORY: existsSync(cwd() + '/.git'),
    SYSTEM_PLATFORM: platform,
    SYSTEM_DATE: new Date().toISOString().split('T')[0], // YYYY-MM-DD
    SYSTEM_CURRENT_MODEL: config.defaultModel?.model || 'unknown',
  };

  // ========== 加载工具（新方式） ==========
  // 方式1：加载系统工具
  const systemTools = await loadSystemTools();
  console.log(`[工具] 已加载 ${systemTools.length} 个系统工具`);

  // 方式2：加载用户自定义工具
  const userTools = await loadUserTools();
  console.log(`[工具] 已加载 ${userTools.length} 个用户工具`);

  // 合并所有工具
  const allTools = [...systemTools, ...userTools];

  // ========== 加载 MCP 配置 ==========
  const mcpConfig = loadMCPConfig('github');
  let mcpFeature: MCPFeature | undefined;
  if (mcpConfig) {
    console.log('[MCP] 已加载 GitHub MCP 配置');
    console.log('[MCP] 可用工具将在首次调用时自动注册');
    mcpFeature = new MCPFeature(mcpConfig);
    mcpFeature.setMCPContext({
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    });
  } else {
    console.log('[MCP] 未找到 GitHub MCP 配置，将使用基础工具集');
  }

  // ========== Agent: 编程小助手 ==========
  const agent = new Agent({
    llm,
    tools: allTools,  // 使用加载的工具
    maxTurns: Infinity,
  });

  // 注册 Features
  agent.use(new SkillFeature('.agentdev/skills'));
  if (mcpFeature) {
    agent.use(mcpFeature);
  }

  agent.setSystemPrompt(new TemplateComposer()
    .add({ file: '.agentdev/prompts/system.md' })
    .add('\n\n## 身份设定\n\n')
    .add('你是一个专业的编程助手，擅长代码编写、调试和优化。')
    .add('\n\n## 技能（Skills）\n\n')
    .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你可以使用 invoke_skill 工具激活技能，以展开技能的详细介绍。\n')
    .add({ skills: '- **{{name}}**: {{description}}' })
    .add('\n\n## MCP 工具\n\n')
    .add('除了标准工具外，你还可以使用 MCP (Model Context Protocol) 工具。MCP 工具的名称以 "mcp." 开头，例如 "mcp.github:create_issue"。这些工具提供了与外部服务集成的能力。\n')
  );

  // 注入系统环境信息
  agent.setSystemContext(systemContext);

  await agent.withViewer('编程小助手', 2026);
  console.log('调试页面: http://localhost:2026\n');

  // Agent 主循环
  const loop = async () => {
    while (true) {
      const input = await agentHook('编程小助手');
      if (input === 'exit') break;
      if (!input) continue;
      console.log(`\n[编程小助手] > ${input}\n---`);
      const result = await agent.onCall(input);
      console.log(`结果: ${result}\n`);
    }
  };

  // 启动 Agent
  await Promise.all([loop()]);
}

main().catch(console.error);
