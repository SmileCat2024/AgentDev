import { ProgrammingHelperAgent } from './ProgrammingHelperAgent.js';
import { exec } from 'child_process';
import { existsSync } from 'fs';
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

async function main() {
  const hasGitHubMCP = existsSync(join(cwd(), '.agentdev', 'mcps', 'github.json'));

  const programmingAgent = new ProgrammingHelperAgent({
    name: '编程小助手',
    mcpServer: hasGitHubMCP ? 'github' : undefined,
  });

  await programmingAgent.withViewer('编程小助手', 2026, false);
  console.log('调试页面: http://localhost:2026\n');

  // 交互循环
  while (true) {
    const input = await agentHook('编程小助手');
    if (input === 'exit' || !input) break;
    console.log(`\n[编程小助手] > ${input}\n---`);
    const result = await programmingAgent.onCall(input);
    console.log(`结果: ${result}\n`);
  }

  await programmingAgent.dispose();
  console.log('[Lifecycle] 程序退出');
}

main().catch(console.error);
