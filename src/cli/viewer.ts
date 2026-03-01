/**
 * Viewer Worker Standalone CLI
 *
 * 独立启动 ViewerWorker 服务器的命令行工具
 *
 * 使用方法：
 *   node dist/cli/viewer.js
 *
 * 环境变量：
 *   AGENTDEV_UDS_PATH - UDS 路径（默认自动检测平台）
 *   AGENTDEV_PORT - HTTP 端口（默认 2026）
 *   AGENTDEV_OPEN_BROWSER - 是否打开浏览器（默认 true）
 */

import { ViewerWorker } from '../core/viewer-worker.js';
import { getDefaultUDSPath } from '../core/types.js';

async function main() {
  const udsPath = process.env.AGENTDEV_UDS_PATH || getDefaultUDSPath();
  const port = parseInt(process.env.AGENTDEV_PORT || '2026', 10);
  const openBrowser = process.env.AGENTDEV_OPEN_BROWSER !== 'false';

  console.log(`[Viewer Worker] 正在启动...`);
  console.log(`[Viewer Worker] UDS: ${udsPath}`);
  console.log(`[Viewer Worker] HTTP: http://localhost:${port}`);

  const worker = new ViewerWorker(port, openBrowser, udsPath);

  try {
    await worker.start();
    console.log('[Viewer Worker] 启动成功');
  } catch (err) {
    console.error('[Viewer Worker] 启动失败:', err);
    process.exit(1);
  }

  // 防止进程退出（保持运行）
  process.on('SIGINT', () => {
    console.log('[Viewer Worker] 收到退出信号，正在关闭...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('[Viewer Worker] 收到终止信号，正在关闭...');
    process.exit(0);
  });

  // 添加未捕获异常处理
  process.on('uncaughtException', (err) => {
    console.error('[Viewer Worker] 未捕获异常:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Viewer Worker] 未处理的 Promise 拒绝:', reason);
    process.exit(1);
  });
}

main();
