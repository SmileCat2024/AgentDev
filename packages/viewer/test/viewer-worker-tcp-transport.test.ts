import { afterEach, describe, expect, it } from 'vitest';
import { connect, createServer, type Socket } from 'net';
import { createServer as createHttpServer } from 'http';
import { once } from 'events';
import { ViewerWorker } from '../src/viewer-worker.js';

function getTestUdsPath(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentdev-tcp-transport-${process.pid}-${Date.now()}-${Math.random()}`
    : `/tmp/agentdev-tcp-transport-${process.pid}-${Date.now()}-${Math.random()}.sock`;
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function getFreeHttpPort(): Promise<number> {
  const server = createHttpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected HTTP address');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

describe('ViewerWorker TCP control transport', () => {
  const originalAddress = process.env.AGENTDEV_VIEWER_ADDR;
  const originalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
  let worker: ViewerWorker | undefined;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await worker?.stop();
    worker = undefined;
    if (originalAddress === undefined) delete process.env.AGENTDEV_VIEWER_ADDR;
    else process.env.AGENTDEV_VIEWER_ADDR = originalAddress;
    if (originalToken === undefined) delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    else process.env.PROTOCLAW_INTERNAL_TOKEN = originalToken;
  });

  it('rejects unauthenticated peers and accepts the configured internal token', async () => {
    const port = await getFreePort();
    const httpPort = await getFreeHttpPort();
    process.env.AGENTDEV_VIEWER_ADDR = `127.0.0.1:${port}`;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'test-internal-token';
    worker = new ViewerWorker(httpPort, false, getTestUdsPath());
    await worker.start();

    const rejected = connect(port, '127.0.0.1');
    sockets.push(rejected);
    rejected.setEncoding('utf8');
    const rejectedData = once(rejected, 'data');
    rejected.write(JSON.stringify({ type: 'register-agent', agentId: 'unauthorized' }) + '\n');
    const [rejectionLine] = await rejectedData;
    expect(JSON.parse(String(rejectionLine)).type).toBe('auth-error');
    const httpAddress = (worker as any).server.address();
    const unauthorizedResponse = await fetch(`http://127.0.0.1:${httpAddress.port}/api/agents`);
    const unauthorizedBody = await unauthorizedResponse.json() as { agents: Array<{ id: string }> };
    expect(unauthorizedBody.agents.some(agent => agent.id === 'unauthorized')).toBe(false);

    const invalid = connect(port, '127.0.0.1');
    sockets.push(invalid);
    invalid.setEncoding('utf8');
    const invalidData = once(invalid, 'data');
    invalid.write(JSON.stringify({ type: 'auth', token: 'wrong-token' }) + '\n');
    const [invalidLine] = await invalidData;
    expect(JSON.parse(String(invalidLine)).type).toBe('auth-error');

    const accepted = connect(port, '127.0.0.1');
    sockets.push(accepted);
    accepted.setEncoding('utf8');
    const acceptedData = once(accepted, 'data');
    accepted.write(JSON.stringify({ type: 'auth', token: 'test-internal-token' }) + '\n');
    const [acceptanceLine] = await acceptedData;
    expect(JSON.parse(String(acceptanceLine)).type).toBe('auth-ok');
    accepted.write(JSON.stringify({ type: 'register-agent', agentId: 'authorized', name: 'Authorized Agent' }) + '\n');
    let authorized = false;
    for (let attempt = 0; attempt < 20 && !authorized; attempt++) {
      const response = await fetch(`http://127.0.0.1:${httpAddress.port}/api/agents`);
      const body = await response.json() as { agents: Array<{ id: string; connected: boolean }> };
      authorized = body.agents.some(agent => agent.id === 'authorized' && agent.connected);
      if (!authorized) await new Promise(resolve => setImmediate(resolve));
    }
    expect(authorized).toBe(true);
  });
});
