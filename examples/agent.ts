import { Agent, createOpenAILLM, loadConfig, fsTools, shellTools, webTools, mathTools, skillTools, TemplateComposer } from '../src/index.js';
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

  // ========== 加载 MCP 配置 ==========
  const mcpConfig = loadMCPConfig('github');
  if (mcpConfig) {
    console.log('[MCP] 已加载 GitHub MCP 配置');
    console.log('[MCP] 可用工具将在首次调用时自动注册');
  } else {
    console.log('[MCP] 未找到 GitHub MCP 配置，将使用基础工具集');
  }

  // ========== Agent1: 编程小助手（带 MCP 支持） ==========
  const agent1 = new Agent({
     llm,
     tools: [fsTools.readFileTool, fsTools.writeFileTool, fsTools.listDirTool, shellTools.shellTool, webTools.webFetchTool, mathTools.calculatorTool, skillTools.invokeSkillTool],
     maxTurns: Infinity,
     skillsDir: '.agentdev/skills',  // 设置 skills 目录
     mcp: mcpConfig,  // MCP 配置（可选）
     mcpContext: {  // MCP 运行时上下文
       GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
     },
  });
  agent1.setSystemPrompt(new TemplateComposer()
    .add({ file: '.agentdev/prompts/system.md' })  // 通用提示词,用默认路径加载
    .add('\n\n## 身份设定\n\n')
    .add('你是一个专业的编程助手，擅长代码编写、调试和优化。')
    .add('\n\n## 技能（Skills）\n\n')
    .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你拥有如下技能，可使用 invoke_skill 工具激活，以展开技能的详细介绍。\n')
    .add({ skills: '- **{{name}}**: {{description}}' })
    .add('\n\n## MCP 工具\n\n')
    .add('除了标准工具外，你还可以使用 MCP (Model Context Protocol) 工具。MCP 工具的名称以 "mcp." 开头，例如 "mcp.github:create_issue"。这些工具提供了与外部服务集成的能力。\n')
  );
  // 注入系统环境信息
  agent1.setSystemContext(systemContext);

  // ========== Agent2: 数据分析师 ==========
  const agent2 = new Agent({
     llm,
     tools: [fsTools.readFileTool, fsTools.writeFileTool, fsTools.listDirTool, shellTools.shellTool, webTools.webFetchTool, mathTools.calculatorTool],
     maxTurns: Infinity,
  });
  agent2.setSystemPrompt(new TemplateComposer()
    .add({ file: '.agentdev/prompts/system.md' })  // 通用提示词，用cwd的相对路径加载
    .add('\n\n## 身份设定\n\n')
    .add('你是一个数据分析师，擅长数据处理、统计分析和可视化。')
  );
  // 注入系统环境信息
  agent2.setSystemContext(systemContext);

  await agent1.withViewer('编程小助手', 2026);
  await agent2.withViewer('数据分析师');
  console.log('调试页面: http://localhost:2026\n');

  // Agent1
  const loop1 = async () => {
    while (true) {
      const input = await agentHook('编程小助手');
      if (input === 'exit') break;
      if (!input) continue;
      console.log(`\n[编程小助手] > ${input}\n---`);
      const result = await agent1.onCall(input);
      console.log(`结果: ${result}\n`);
    }
  };

  // Agent2(暂时不需要启动)
  const loop2 = async () => {
    while (true) {
      const input = await agentHook('数据分析师');
      if (input === 'exit') break;
      if (!input) continue;
      console.log(`\n[数据分析师] > ${input}\n---`);
      const result = await agent2.onCall(input);
      console.log(`结果: ${result}\n`);
    }
  };

  // 启动 Agent1
  await Promise.all([loop1()]);
}

main().catch(console.error);
