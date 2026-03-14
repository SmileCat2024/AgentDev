import { ProgrammingHelperAgent } from './ProgrammingHelperAgent.js';
import { UserInputFeature } from '../src/features/index.js';
import { FileSessionStore } from '../src/core/session-store.js';

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

const SESSION_ID = 'examples-programming-helper-last';
const shouldResumeSession = process.env.AGENTDEV_RESUME_SESSION === '1';

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
  const mcpMode = resolveExampleMCPMode();
  console.log(`[Example] MCP mode: ${mcpMode === undefined ? 'auto' : String(mcpMode)}`);

  // 创建用户输入 Feature
  const userInputFeature = new UserInputFeature();
  const sessionStore = new FileSessionStore();

  const programmingAgent = new ProgrammingHelperAgent({
    name: '编程小助手',
    mcpServer: mcpMode,
  }).use(userInputFeature);

  if (shouldResumeSession) {
    try {
      await programmingAgent.loadSession(SESSION_ID, sessionStore);
      const restoredMessages = programmingAgent.getContext().getAll().length;
      console.log(`[Example] 已恢复上次会话: ${SESSION_ID}，当前消息数: ${restoredMessages}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Example] 未找到可恢复会话，改为新会话启动: ${message}`);
    }
  } else {
    console.log('[Example] 新会话启动，不加载历史会话');
  }

  await programmingAgent.withViewer('编程小助手', 2026, false);
  console.log('调试页面: http://localhost:2026\n');

  // 交互循环
  while (true) {
    const userEvent = await userInputFeature.getUserInputEvent('请输入您的需求（输入 exit 退出）：');
    if (userEvent.kind === 'action') {
      if (userEvent.actionId === 'rollback_to_call') {
        const targetCallIndex = Number(userEvent.payload?.callIndex);
        const draftInput = typeof userEvent.payload?.draftInput === 'string'
          ? userEvent.payload.draftInput
          : '';
        const rollback = await programmingAgent.rollbackToCall(targetCallIndex);
        userInputFeature.setNextDraftInput(draftInput || rollback.draftInput);
        await programmingAgent.saveSession(SESSION_ID, sessionStore);
        console.log(`[Example] 已回退到第 ${targetCallIndex + 1} 轮输入，等待重新编辑`);
        continue;
      }

      console.log(`[Example] 忽略未知输入动作: ${userEvent.actionId ?? 'unknown'}`);
      continue;
    }

    const input = userEvent.text ?? '';
    if (input === 'exit' || !input) break;
    console.log(`\n[编程小助手] > ${input}\n---`);
    const result = await programmingAgent.onCall(input);
    await programmingAgent.saveSession(SESSION_ID, sessionStore);
    console.log(`结果: ${result}\n`);
  }

  await programmingAgent.saveSession(SESSION_ID, sessionStore);
  await programmingAgent.dispose();
  console.log('[Lifecycle] 程序退出');
}

main().catch(console.error);
