/**
 * Vitest 全局 setup
 *
 * 在每个测试文件执行前运行一次。
 */

// 测试中静默 [PASS] / [DONE] 等非关键 info 输出
// 通过 AGENTDEV_TEST_VERBOSE=1 可恢复全部输出
if (!process.env.AGENTDEV_TEST_VERBOSE) {
  const origInfo = console.info;
  console.info = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (first.startsWith('[PASS]') || first.startsWith('[DONE]') || first.startsWith('[TTSFeature]')) {
      return;
    }
    origInfo(...args);
  };
}

// 指向不存在的端口，禁用 react-loop step 边界对本地 ViewerWorker 的排队消息
// 探测（fetchQueuedInput）。默认端口 2026 上若本机 Claw 服务在跑，探测请求
// 会命中真实服务且受 keep-alive 时序影响，在墙钟敏感的测试中引入数百毫秒抖动。
// fetchQueuedInput 内部对空值回退 2026，因此这里必须赋非空值；
// 外部通过 AGENTDEV_TEST_VIEWER_PORT 显式指定时尊重之。
process.env.AGENTDEV_VIEWER_PORT = process.env.AGENTDEV_TEST_VIEWER_PORT || '1';
