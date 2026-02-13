import { Agent, createOpenAILLM, loadConfig, fsTools, shellTools, webTools, mathTools } from '../src/index.js';
import { exec } from 'child_process';

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

  const agent1 = new Agent({ 
     llm, 
     tools: [fsTools.readFileTool, fsTools.writeFileTool, fsTools.listDirTool, shellTools.shellTool, webTools.webFetchTool, mathTools.calculatorTool], 
     maxTurns: Infinity, 
     systemMessage: '你是 Agent1，一个专业的编程助手。' });
  const agent2 = new Agent({ 
     llm, 
     tools: [fsTools.readFileTool, fsTools.writeFileTool, fsTools.listDirTool, shellTools.shellTool, webTools.webFetchTool, mathTools.calculatorTool], 
     maxTurns: Infinity, 
     systemMessage: '你是 Agent2，一个数据分析师。' });

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

  // Agent2
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

  await Promise.all([loop1(), loop2()]);
}

main().catch(console.error);
