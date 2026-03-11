import { execSync } from 'child_process';
import { glob } from 'glob';

const files = glob.sync([
  'src/test/**/*.test.ts',
  'src/features/*/test/**/*.test.ts'
]);

let passed = 0, failed = 0;

for (const file of files) {
  console.log(`\n▶ ${file}`);
  try {
    execSync(`tsx ${file}`, { stdio: 'inherit' });
    passed++;
  } catch {
    failed++;
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
