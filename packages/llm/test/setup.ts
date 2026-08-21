/**
 * Vitest 全局 setup（@agentdev/llm）
 */
if (!process.env.AGENTDEV_TEST_VERBOSE) {
  const origInfo = console.info;
  console.info = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (first.startsWith('[PASS]') || first.startsWith('[DONE]')) {
      return;
    }
    origInfo(...args);
  };
}
