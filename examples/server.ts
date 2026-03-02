/**
 * ViewerWorker 服务器启动程序
 *
 * 用途：独立启动调试查看器服务器
 * 运行：npm run server 或 node dist/cli/server.js
 *
 * 功能：
 * - 启动 ViewerWorker 独立进程
 * - 服务器运行期间可以被多个 Agent 连接
 * - Ctrl+C 关闭服务器
 */

import { ViewerWorker } from '../src/core/viewer-worker.js';
import { getDefaultUDSPath } from '../src/core/types.js';

const DEFAULT_PORT = 2026;

async function main() {
  const port = parseInt(process.env.AGENTDEV_PORT || process.argv[2] || String(DEFAULT_PORT), 10);
  const openBrowser = process.env.AGENTDEV_OPEN_BROWSER !== 'false' && process.argv[3] !== 'false';
  const udsPath = process.env.AGENTDEV_UDS_PATH || process.argv[4];

  console.log('='.repeat(50));
  console.log('ViewerWorker 服务器启动中...');
  console.log(`  HTTP 端口: ${port}`);
  console.log(`  UDS 路径: ${udsPath || getDefaultUDSPath()}`);
  console.log(`  自动打开浏览器: ${openBrowser ? '是' : '否'}`);
  console.log('='.repeat(50));

  const worker = new ViewerWorker(port, openBrowser, udsPath);

  try {
    await worker.start();

    console.log('\n✓ 服务器已启动!');
    console.log(`\n调试页面: http://localhost:${port}`);
    console.log('\n按 Ctrl+C 停止服务器\n');

    // 保持运行，直到用户中断
  } catch (err) {
    console.error('\n✗ 服务器启动失败:', err);
    process.exit(1);
  }
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n[Server] 正在停止服务器...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n[Server] 正在停止服务器...');
  process.exit(0);
});

main().catch((err) => {
  console.error('[Server] 未处理的错误:', err);
  process.exit(1);
});
