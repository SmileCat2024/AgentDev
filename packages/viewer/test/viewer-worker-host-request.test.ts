import { afterEach, describe, expect, it } from 'vitest';
import { connect, createServer, type Socket } from 'net';
import { createServer as createHttpServer } from 'http';
import { once } from 'events';
import { ViewerWorker } from '../src/viewer-worker.js';

function getTestUdsPath(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentdev-host-request-${process.pid}-${Date.now()}-${Math.random()}`
    : `/tmp/agentdev-host-request-${process.pid}-${Date.now()}-${Math.random()}.sock`;
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

/** 连接 + 认证 + 注册一个 agent，返回收帧队列与应答器。 */
async function attachRuntime(port: number, agentId: string, sockets: Socket[]) {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  socket.setEncoding('utf8');
  await once(socket, 'connect');
  socket.write(JSON.stringify({ type: 'auth', token: 'test-internal-token' }) + '\n');
  socket.write(JSON.stringify({ type: 'register-agent', agentId, name: `${agentId} Agent` }) + '\n');
  const received: any[] = [];
  socket.on('data', (data: string) => {
    for (const line of String(data).split('\n')) {
      if (!line) continue;
      try { received.push(JSON.parse(line)); } catch { /* 跨 chunk 半行 */ }
    }
  });
  return { socket, received };
}

async function waitForConnected(httpPort: number, agentId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`http://127.0.0.1:${httpPort}/api/agents`);
    const body = await response.json() as { agents: Array<{ id: string; connected: boolean }> };
    if (body.agents.some(agent => agent.id === agentId && agent.connected)) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Agent ${agentId} never connected`);
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Condition never met');
}

describe('ViewerWorker host-request channel', () => {
  const originalAddress = process.env.AGENTDEV_VIEWER_ADDR;
  const originalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
  const originalTimeout = process.env.AGENTDEV_HOST_REQUEST_TIMEOUT_MS;
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
    if (originalTimeout === undefined) delete process.env.AGENTDEV_HOST_REQUEST_TIMEOUT_MS;
    else process.env.AGENTDEV_HOST_REQUEST_TIMEOUT_MS = originalTimeout;
  });

  it('round-trips a host request to the runtime and returns its result', async () => {
    const port = await getFreePort();
    const httpPort = await getFreeHttpPort();
    process.env.AGENTDEV_VIEWER_ADDR = `127.0.0.1:${port}`;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'test-internal-token';
    worker = new ViewerWorker(httpPort, false, getTestUdsPath());
    await worker.start();

    const { socket, received } = await attachRuntime(port, 'request-target', sockets);
    await waitForConnected(httpPort, 'request-target');

    const responsePromise = fetch(`http://127.0.0.1:${httpPort}/api/agents/request-target/host-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'feature-comms', featureId: 'shell', requestType: 'list' }),
    });
    // runtime 收帧后原路应答（等待 viewer 下发完成再回，避免写回早于注册处理）
    const frame = await waitFor(() => received.find(message => message.type === 'host-request'));
    expect(frame.agentId).toBe('request-target');
    expect(frame.payload).toEqual({ kind: 'feature-comms', featureId: 'shell', requestType: 'list' });
    socket.write(JSON.stringify({ type: 'host-response', requestId: frame.requestId, result: { ok: true, tasks: [] } }) + '\n');

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, result: { ok: true, tasks: [] } });
  });

  it('surfaces runtime-side errors as 502', async () => {
    const port = await getFreePort();
    const httpPort = await getFreeHttpPort();
    process.env.AGENTDEV_VIEWER_ADDR = `127.0.0.1:${port}`;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'test-internal-token';
    worker = new ViewerWorker(httpPort, false, getTestUdsPath());
    await worker.start();

    const { socket, received } = await attachRuntime(port, 'error-target', sockets);
    await waitForConnected(httpPort, 'error-target');

    const responsePromise = fetch(`http://127.0.0.1:${httpPort}/api/agents/error-target/host-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ probe: 1 }),
    });
    const frame = await waitFor(() => received.find(message => message.type === 'host-request'));
    socket.write(JSON.stringify({ type: 'host-response', requestId: frame.requestId, error: 'Feature does not handle host requests' }) + '\n');

    const response = await responsePromise;
    expect(response.status).toBe(502);
    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('host requests');
  });

  it('times out unanswered requests with 504', async () => {
    const port = await getFreePort();
    const httpPort = await getFreeHttpPort();
    process.env.AGENTDEV_VIEWER_ADDR = `127.0.0.1:${port}`;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'test-internal-token';
    process.env.AGENTDEV_HOST_REQUEST_TIMEOUT_MS = '120';
    worker = new ViewerWorker(httpPort, false, getTestUdsPath());
    await worker.start();

    await attachRuntime(port, 'silent-target', sockets);
    await waitForConnected(httpPort, 'silent-target');

    const response = await fetch(`http://127.0.0.1:${httpPort}/api/agents/silent-target/host-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(504);
    const body = await response.json() as { success: boolean; code: string };
    expect(body.code).toBe('host_request_timeout');
  });

  it('fails in-flight requests when the runtime connection drops', async () => {
    const port = await getFreePort();
    const httpPort = await getFreeHttpPort();
    process.env.AGENTDEV_VIEWER_ADDR = `127.0.0.1:${port}`;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'test-internal-token';
    worker = new ViewerWorker(httpPort, false, getTestUdsPath());
    await worker.start();

    const { socket, received } = await attachRuntime(port, 'dropping-target', sockets);
    await waitForConnected(httpPort, 'dropping-target');

    const responsePromise = fetch(`http://127.0.0.1:${httpPort}/api/agents/dropping-target/host-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await waitFor(() => received.find(message => message.type === 'host-request'));
    socket.destroy();

    const response = await responsePromise;
    expect(response.status).toBe(502);
    const body = await response.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it('validates input: unknown agent 404, bad JSON 400, disconnected runtime 409', async () => {
    const port = await getFreePort();
    const httpPort = await getFreeHttpPort();
    process.env.AGENTDEV_VIEWER_ADDR = `127.0.0.1:${port}`;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'test-internal-token';
    worker = new ViewerWorker(httpPort, false, getTestUdsPath());
    await worker.start();

    const unknown = await fetch(`http://127.0.0.1:${httpPort}/api/agents/ghost/host-request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(unknown.status).toBe(404);

    const { socket } = await attachRuntime(port, 'registered-only', sockets);
    await waitForConnected(httpPort, 'registered-only');
    socket.destroy();
    // 等 viewer 侧感知断连（session 仍在但连接已失）
    let refused = false;
    for (let attempt = 0; attempt < 100 && !refused; attempt++) {
      const response = await fetch(`http://127.0.0.1:${httpPort}/api/agents/registered-only/host-request`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (response.status === 409) { refused = true; break; }
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(refused).toBe(true);

    const badJson = await fetch(`http://127.0.0.1:${httpPort}/api/agents/ghost/host-request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    });
    expect(badJson.status).toBe(400);
  });
});
