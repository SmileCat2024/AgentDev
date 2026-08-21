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
