import { spawnSync } from 'child_process';
import { glob } from 'glob';

const files = glob.sync([
  'src/test/**/*.test.ts',
  'src/features/*/test/**/*.test.ts'
]);
const timeoutMs = Number(process.env.AGENTDEV_TEST_TIMEOUT_MS ?? 60000);

let passed = 0, failed = 0;

for (const file of files) {
  console.log(`\n▶ ${file}`);
  const result = spawnSync('tsx', [file], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: timeoutMs,
  });

  if (result.status === 0) {
    passed++;
    continue;
  }

  failed++;
  if (result.error) {
    const isTimeout = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    console.error(isTimeout
      ? `[TIMEOUT] ${file} exceeded ${timeoutMs}ms`
      : `[FAIL] ${file}: ${result.error.message}`);
  } else if (result.signal) {
    console.error(`[FAIL] ${file} terminated by ${result.signal}`);
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
