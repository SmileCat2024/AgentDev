import { ProgrammingHelperAgent } from './ProgrammingHelperAgent.js';
import { UserInputFeature } from '../src/features/user-input.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { cwd } from 'process';

/**
 * 检查 ViewerWorker 是否运行
 */
async function checkViewerRunning(port: number = 2026): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/agents`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  // 检查 ViewerWorker 是否运行
  const isRunning = await checkViewerRunning(2026);
  if (!isRunning) {
    console.error('错误: ViewerWorker 服务器未运行');
    console.error('请先启动服务器: npm run server');
    console.error('');
    console.error('或者在新终端运行:');
    console.error('  npm run server');
    console.error('');
    console.error('程序将在 5 秒后退出...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    process.exit(1);
  }

  console.log('✓ 已连接到 ViewerWorker\n');

  const hasGitHubMCP = existsSync(join(cwd(), '.agentdev', 'mcps', 'github.json'));

  // 创建用户输入 Feature
  const userInputFeature = new UserInputFeature({ timeout: 300000 });

  const programmingAgent = new ProgrammingHelperAgent({
    name: '编程小助手',
    mcpServer: hasGitHubMCP ? 'github' : undefined,
  }).use(userInputFeature);

  await programmingAgent.withViewer('编程小助手', 2026, false);
  console.log('调试页面: http://localhost:2026\n');

  // 交互循环
  while (true) {
    const input = await userInputFeature.getUserInput('请输入您的需求（输入 exit 退出）：');
    if (input === 'exit' || !input) break;
    console.log(`\n[编程小助手] > ${input}\n---`);
    const result = await programmingAgent.onCall(input);
    console.log(`结果: ${result}\n`);
  }

  await programmingAgent.dispose();
  console.log('[Lifecycle] 程序退出');
}

main().catch(console.error);
