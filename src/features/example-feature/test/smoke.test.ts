/**
 * Example Feature Smoke Test
 *
 * 运行方式：npm test 会自动执行
 */

import { ExampleFeature } from '../index.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const feature = new ExampleFeature();
  const snapshot = feature.captureState() as { enabled: boolean; counter: number };

  assert(snapshot.enabled === true, 'example feature should enable by default');
  assert(snapshot.counter === 0, 'example feature counter should start at zero');

  console.log('[PASS] Example feature smoke test passed');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
