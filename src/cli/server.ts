/**
 * ViewerWorker 服务器启动程序
 *
 * 用途：独立启动调试查看器服务器
 * 运行：npm run server [port] [no-browser] [uds-path]
 *
 * 功能：
 * - 启动 ViewerWorker 独立进程
 * - 服务器运行期间可以被多个 Agent 连接
 * - Ctrl+C 关闭服务器
 *
 * 参数：
 *   port - HTTP 端口（默认 2026）
 *   no-browser - 不自动打开浏览器（传递字符串 "false"）
 *   uds-path - 自定义 UDS 路径（可选）
 *
 * 环境变量：
 *   AGENTDEV_PORT - HTTP 端口（默认 2026）
 *   AGENTDEV_OPEN_BROWSER - 是否打开浏览器（默认 true）
 *   AGENTDEV_UDS_PATH - UDS 路径（默认自动检测平台）
 */

import { ViewerWorker } from '../core/viewer-worker.js';
import { getDefaultUDSPath } from '../core/types.js';

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
