/**
 * QQBot 编程小助手示例
 *
 * 按照 agent.ts 的模式编写
 * 检查 ViewerWorker → 创建 Agent → 启动 Gateway → 保持运行
 */

import { QQBotProgrammingHelperAgent } from './QQBotProgrammingHelperAgent.js';
import { checkDebugTransportRunning, getDebugUiUrl, printDebugTransportHelp, resolveDebugTransportMode } from './debug-runtime.js';

function resolveExampleMCPMode(): string | false | undefined {
  const rawMode = process.env.AGENTDEV_EXAMPLE_MCP?.trim();
  if (!rawMode || rawMode.toLowerCase() === 'auto') {
    return undefined;
  }

  const normalized = rawMode.toLowerCase();
  if (normalized === 'off' || normalized === 'false' || normalized === 'none') {
    return false;
  }

  return rawMode;
}

async function main() {
  const transport = resolveDebugTransportMode();
  const isRunning = await checkDebugTransportRunning(2026);
  if (!isRunning) {
    printDebugTransportHelp(2026);
    console.error('程序将在 5 秒后退出...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    process.exit(1);
  }

  console.log(`✓ 已连接到 ${transport}\n`);
  const mcpMode = resolveExampleMCPMode();
  console.log(`[Example] MCP mode: ${mcpMode === undefined ? 'auto' : String(mcpMode)}\n`);

  // 创建 QQBot 编程小助手
  const qqbotAgent = new QQBotProgrammingHelperAgent({
    name: 'QQBot 编程助手',
    mcpServer: mcpMode,
    // QQ Bot 配置（可选，也可以通过 .agentdev/qqbot.config.json 配置）
    // appId: process.env.QQBOT_APP_ID,
    // clientSecret: process.env.QQBOT_CLIENT_SECRET,
  });

  await qqbotAgent.withViewer('QQBot 编程助手', 2026, false);
  console.log(`调试页面: ${getDebugUiUrl(2026)}\n`);

  // 启动 QQ Bot Gateway
  await qqbotAgent.startQQBotGateway();

  console.log('========================================');
  console.log('QQBot 编程助手已启动！');
  console.log(`调试页面: ${getDebugUiUrl(2026)}`);
  console.log('========================================');
  console.log('现在可以通过 QQ 与机器人对话...');
  console.log('能力包括：');
  console.log('  - 代码编写、调试和优化');
  console.log('  - 任务管理（TodoFeature）');
  console.log('  - 窗口截图和视觉理解');
  console.log('  - Web 搜索和网页抓取');
  console.log('  - MCP 工具支持');
  console.log('========================================');
  console.log('按 Ctrl+C 退出程序');
  console.log('========================================\n');

  // 保持程序运行
  await new Promise<void>((resolve, reject) => {
    process.on('SIGINT', () => {
      console.log('\n[QQBot] 正在退出...');
      qqbotAgent.dispose().then(() => resolve());
    });
    process.on('SIGTERM', () => {
      console.log('\n[QQBot] 收到终止信号，正在退出...');
      qqbotAgent.dispose().then(() => resolve());
    });
  });

  await qqbotAgent.dispose();
  console.log('[Lifecycle] 程序退出');
}

main().catch(console.error);
