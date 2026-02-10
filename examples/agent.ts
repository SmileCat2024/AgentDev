/**
 * 基础 Agent 示例
 * 使用 @openai/agents SDK 工具
 */

import { Agent, createOpenAILLM, loadConfig, fsTools, shellTools, webTools, mathTools } from '../src/index.js';

// ==================== 主程序 ====================

async function main() {
  const config = await loadConfig();
  const llm = createOpenAILLM(config.model.apiKey, config.model.name, config.model.baseUrl);

  const agent = new Agent({
    llm,
    tools: [
      fsTools.readFileTool,
      fsTools.writeFileTool,
      fsTools.listDirTool,
      shellTools.shellTool,
      webTools.webFetchTool,
      mathTools.calculatorTool,
    ],
    maxTurns: 15,
    systemMessage: '你是一个编码助手，可以使用工具来读写文件、执行命令、获取网页内容。',
  });

  // 启用可视化查看器
  await agent.withViewer(2027);

  console.log('--- Agent 运行中 ---\n');
  console.log('工具:', ['read_file', 'write_file', 'list_directory', 'run_shell_command', 'web_fetch', 'calculator'].join(', '));
  console.log();

  const tasks = [
    '请执行npx agenthook命令'
  ];

  for (const task of tasks) {
    console.log(`\n任务: ${task}`);
    console.log('---');
    const result = await agent.run(task);
    console.log('\n结果:', result);
  }
}

main().catch(console.error);
