import { Agent, createOpenAILLM, loadConfig, fsTools, shellTools, webTools, mathTools, TemplateComposer } from '../src/index.js';
import { exec } from 'child_process';
import { existsSync } from 'fs';
import { cwd, platform } from 'process';

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

  // ========== Agent1: 编程小助手 ==========
  const agent1 = new Agent({
     llm,
     tools: [fsTools.readFileTool, fsTools.writeFileTool, fsTools.listDirTool, shellTools.shellTool, webTools.webFetchTool, mathTools.calculatorTool],
     maxTurns: Infinity,
  });
  agent1.setSystemPrompt(new TemplateComposer()
    .add({ file: '../prompts/system.md' })  // 通用提示词
    .add('\n\n## 身份设定\n\n')
    .add('你是一个专业的编程助手，擅长代码编写、调试和优化。')
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
    .add({ file: '../prompts/system.md' })  // 通用提示词
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

  await Promise.all([loop1()]);
}

main().catch(console.error);
