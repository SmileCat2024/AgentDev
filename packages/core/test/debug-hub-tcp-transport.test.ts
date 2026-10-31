import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { DebugHub } from '../src/core/debug-hub.js';

describe('DebugHub TCP control transport', () => {
  const originalAddress = process.env.AGENTDEV_VIEWER_ADDR;
  const originalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
  let hub: DebugHub | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let client: Socket | undefined;
  let pendingTimers: NodeJS.Timeout[] = [];

  afterEach(async () => {
    for (const timer of pendingTimers.splice(0)) clearTimeout(timer);
    hub?.stop();
    client?.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    hub = undefined;
    server = undefined;
    client = undefined;
    (DebugHub as any).instance = undefined;
    if (originalAddress === undefined) delete process.env.AGENTDEV_VIEWER_ADDR;
    else process.env.AGENTDEV_VIEWER_ADDR = originalAddress;
    if (originalToken === undefined) delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    else process.env.PROTOCLAW_INTERNAL_TOKEN = originalToken;
  });

  it('authenticates before reporting the ViewerWorker connection ready', async () => {
    server = createServer(socket => {
      client = socket;
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (data: string) => {
        buffer += data;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.type === 'auth' && message.token === 'integration-token') {
            socket.write(JSON.stringify({ type: 'auth-ok' }) + '\n');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');

    process.env.AGENTDEV_VIEWER_ADDR = `127.0.0.1:${address.port}`;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'integration-token';
    (DebugHub as any).instance = undefined;
    hub = DebugHub.getInstance();

    await hub.start(0, false);
    expect(hub.isConnected()).toBe(true);
  });

  it('dispatches stop-agent to the registered stop handler', async () => {
    server = createServer(socket => {
      client = socket;
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (data: string) => {
        buffer += data;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.type === 'auth' && message.token === 'integration-token') {
            socket.write(JSON.stringify({ type: 'auth-ok' }) + '\n');
            // auth-ok 到测试注册 stop handler 之间存在窗口：延迟重发直到
            // handler 挂上（handler 注册是 start 返回后的第一条语句）。
            for (let attempt = 1; attempt <= 3; attempt += 1) {
              pendingTimers.push(setTimeout(() => {
                if (socket.destroyed) return;
                socket.write(JSON.stringify({ type: 'stop-agent', agentId: 'ext-agent-1' }) + '\n');
              }, attempt * 100));
            }
          }
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');

    process.env.AGENTDEV_VIEWER_ADDR = `127.0.0.1:${address.port}`;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'integration-token';
    (DebugHub as any).instance = undefined;
    hub = DebugHub.getInstance();

    await hub.start(0, false);
    expect(hub.isConnected()).toBe(true);

    const stoppedAgentId = new Promise<string>(resolve => {
      hub!.setStopHandler('ext-agent-1', agentId => { resolve(agentId); });
    });
    expect(await stoppedAgentId).toBe('ext-agent-1');
  });
});
