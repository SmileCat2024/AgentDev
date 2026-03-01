import { ProgrammingHelperAgent } from './ProgrammingHelperAgent.js';
import { exec } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { cwd } from 'process';
import { createConnection } from 'net';
import { getDefaultUDSPath } from '../src/core/types.js';

/**
 * 检查 ViewerWorker 是否已运行
 */
function isViewerRunning(port: number = 2026): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection({ port, host: 'localhost' });
    client.on('connect', () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => resolve(false));
  });
}

/**
 * 启动 ViewerWorker（独立进程）
 */
async function ensureViewerRunning(): Promise<void> {
  const alreadyRunning = await isViewerRunning(2026);
  if (alreadyRunning) {
    console.log('[启动] ViewerWorker 已在运行');
    return;
  }

  console.log('[启动] 正在启动 ViewerWorker...');
  const { spawn } = await import('child_process');
  const viewerPath = join(cwd(), 'dist', 'cli', 'viewer.js');

  // 使用 detached 让 ViewerWorker 作为独立进程运行
  const child = spawn(process.execPath, [viewerPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,  // 所有平台统一使用独立进程
    env: { ...process.env, AGENTDEV_OPEN_BROWSER: 'false' },
  });

  // unref() 让父进程不等待子进程，子进程独立运行
  child.unref();

  // 记录子进程的输出以便调试
  child.stdout?.on('data', (data) => {
    console.log(`[Viewer] ${data.toString().trim()}`);
  });
  child.stderr?.on('data', (data) => {
    console.error(`[Viewer Error] ${data.toString().trim()}`);
  });

  child.on('error', (err) => {
    console.error('[启动] ViewerWorker 启动失败:', err);
  });

  child.on('exit', (code, signal) => {
    console.error(`[启动] ViewerWorker 意外退出: code=${code}, signal=${signal}`);
  });

  // 等待服务器启动并重试检查
  const maxRetries = 10;
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const running = await isViewerRunning(2026);
    if (running) {
      console.log('[启动] ViewerWorker 已启动');
      return;
    }
  }

  throw new Error('[启动] ViewerWorker 启动超时，请检查是否有错误日志');
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
  // 确保 ViewerWorker 运行
  await ensureViewerRunning();

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
