import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const child = spawn(
  'npm',
  ['run', 'claw:smoke'],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTDEV_DEBUG_TRANSPORT: process.env.AGENTDEV_DEBUG_TRANSPORT || 'claw',
      AGENTDEV_CLAW_RUNTIME_URL: process.env.AGENTDEV_CLAW_RUNTIME_URL || 'http://127.0.0.1:3030',
    },
    stdio: 'inherit',
    shell: true,
  }
);

child.on('exit', code => {
  process.exitCode = code ?? 1;
});

child.on('error', error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
