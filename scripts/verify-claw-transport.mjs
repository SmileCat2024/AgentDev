import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const runtimeModuleUrl = pathToFileURL(path.resolve(repoRoot, '..', 'AgentDevClaw', 'apps', 'runtime', 'src', 'server.js')).href;
  const { startRuntimeServer } = await import(runtimeModuleUrl);
  const runtimePort = 3130;
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const server = await startRuntimeServer({ runtimePort });

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        'npm',
        ['run', 'claw:smoke'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            AGENTDEV_DEBUG_TRANSPORT: 'claw',
            AGENTDEV_CLAW_RUNTIME_URL: runtimeUrl,
          },
          stdio: 'inherit',
          shell: true,
        }
      );

      child.on('exit', code => {
        if (code === 0) {
          resolve(undefined);
          return;
        }
        reject(new Error(`claw:smoke exited with code ${code ?? 'unknown'}`));
      });

      child.on('error', reject);
    });

    const agentsResponse = await fetch(`${runtimeUrl}/api/agents`);
    const agents = await agentsResponse.json();
    const logsResponse = await fetch(`${runtimeUrl}/api/logs?scope=all`);
    const logs = await logsResponse.json();
    console.log(`[Verify] agents=${agents.agents.length} logs=${logs.logs.length}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
