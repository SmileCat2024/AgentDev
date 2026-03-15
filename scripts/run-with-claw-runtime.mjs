import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const clawRepoRoot = path.resolve(repoRoot, '../AgentDevClaw');
const [, , ...scriptArgs] = process.argv;

if (scriptArgs.length === 0) {
  console.error('Usage: node scripts/run-with-claw-runtime.mjs <npm-script> [...extraArgs]');
  process.exit(1);
}

const [npmScript, ...extraArgs] = scriptArgs;
const runtimeUrl = (process.env.AGENTDEV_CLAW_RUNTIME_URL || 'http://127.0.0.1:3030').replace(/\/$/, '');

async function isRuntimeReady() {
  try {
    const response = await fetch(`${runtimeUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForRuntime(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRuntimeReady()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

async function ensureRuntimeRunning() {
  if (await isRuntimeReady()) {
    return;
  }

  console.log(`[Claw] runtime not detected at ${runtimeUrl}, starting AgentDevClaw...`);
  const runtimeChild = spawn(
    'npm',
    ['run', 'dev:runtime'],
    {
      cwd: clawRepoRoot,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      shell: true,
    }
  );
  runtimeChild.unref();

  const ready = await waitForRuntime();
  if (!ready) {
    console.error(`[Claw] failed to reach runtime at ${runtimeUrl}`);
    console.error(`Please start it manually in ${clawRepoRoot}`);
    process.exit(1);
  }

  console.log(`[Claw] runtime ready at ${runtimeUrl}`);
}

await ensureRuntimeRunning();

const child = spawn(
  'npm',
  ['run', npmScript, '--', ...extraArgs],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTDEV_DEBUG_TRANSPORT: process.env.AGENTDEV_DEBUG_TRANSPORT || 'claw',
      AGENTDEV_CLAW_RUNTIME_URL: runtimeUrl,
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
