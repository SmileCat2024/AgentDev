import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

async function waitForPendingRequest(runtimeUrl, maxAttempts = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const agentsRes = await fetch(`${runtimeUrl}/api/agents`);
    const agents = await agentsRes.json();
    const currentAgentId = agents.currentAgentId;
    if (currentAgentId) {
      const reqRes = await fetch(`${runtimeUrl}/api/agents/${encodeURIComponent(currentAgentId)}/input-requests`);
      const requests = await reqRes.json();
      if (Array.isArray(requests) && requests.length > 0) {
        return { currentAgentId, request: requests[0] };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for pending input request');
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const runtimeModuleUrl = pathToFileURL(path.resolve(repoRoot, '..', 'AgentDevClaw', 'apps', 'runtime', 'src', 'server.js')).href;
  const { startRuntimeServer } = await import(runtimeModuleUrl);
  const runtimePort = 3134;
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const server = await startRuntimeServer({ runtimePort });

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        'npx',
        ['tsx', 'examples/claw-input-bridge-smoke.ts'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            AGENTDEV_DEBUG_TRANSPORT: 'claw',
            AGENTDEV_CLAW_RUNTIME_URL: runtimeUrl,
          },
          stdio: 'pipe',
          shell: true,
        }
      );

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      void (async () => {
        const { currentAgentId, request } = await waitForPendingRequest(runtimeUrl);
        const submitRes = await fetch(`${runtimeUrl}/api/agents/${encodeURIComponent(currentAgentId)}/input`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            requestId: request.requestId,
            input: 'bridge-ok',
            response: {
              kind: 'text',
              text: 'bridge-ok',
            },
          }),
        });
        if (!submitRes.ok) {
          throw new Error(`Failed to submit input: ${submitRes.status} ${submitRes.statusText}`);
        }
      })().catch(reject);

      child.on('exit', code => {
        if (code === 0 && stdout.includes('bridge-ok')) {
          console.log(stdout.trim());
          if (stderr.trim()) {
            console.error(stderr.trim());
          }
          resolve(undefined);
          return;
        }
        reject(new Error(`input bridge smoke failed with code ${code ?? 'unknown'}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      });

      child.on('error', reject);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

