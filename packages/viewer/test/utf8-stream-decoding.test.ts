import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DebugHub } from '../core/debug-hub.js';
import { ViewerWorker } from '../core/viewer-worker.js';

function getTestUdsPath(): string {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentdev-utf8-${id}`
    : `/tmp/agentdev-utf8-${id}.sock`;
}

function splitInsideChineseCharacter(value: string): [Buffer, Buffer] {
  const bytes = Buffer.from(value, 'utf8');
  const splitAt = bytes.indexOf(Buffer.from('中', 'utf8')) + 1;
  return [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
}

function createResponse() {
  let status = 0;
  let body = '';
  return {
    writeHead(code: number) { status = code; },
    end(value: string) { body = value; },
    get status() { return status; },
    get json() { return JSON.parse(body); },
  };
}

describe('UTF-8 stream decoding', () => {
  it('preserves Chinese text when a UDS message splits inside a character', async () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    (worker as any).startUDSServer();

    const socket = connect((worker as any).udsPath);
    await once(socket, 'connect');

    const message = JSON.stringify({
      type: 'register-agent',
      agentId: 'utf8-agent',
      name: '中文 Agent',
      createdAt: Date.now(),
      projectRoot: 'D:/中文项目',
    }) + '\n';
    const [first, second] = splitInsideChineseCharacter(message);
    socket.write(first);
    socket.write(second);

    await new Promise(resolve => setTimeout(resolve, 10));
    expect((worker as any).agentSessions.get('utf8-agent')).toMatchObject({
      name: '中文 Agent',
      projectRoot: 'D:/中文项目',
    });

    socket.end();
    await once(socket, 'close');
    await new Promise<void>(resolve => (worker as any).udsServer.close(resolve));
  });

  it('preserves Chinese text when a DebugHub response splits inside a character', async () => {
    const server = createServer(socket => {
      const response = JSON.stringify({
        type: 'input-response',
        agentId: 'utf8-agent',
        requestId: 'utf8-request',
        input: '中文输入不会变成乱码',
      }) + '\n';
      const [first, second] = splitInsideChineseCharacter(response);
      socket.write(first);
      socket.end(second);
    });
    const udsPath = getTestUdsPath();
    await new Promise<void>(resolve => server.listen(udsPath, resolve));

    const hub = DebugHub.getInstance();
    let received: unknown;
    const originalHandleWorkerMessage = (hub as any).handleWorkerMessage;
    const originalUdsPath = (hub as any).udsPath;
    (hub as any).stopped = true;
    (hub as any).handleWorkerMessage = (message: unknown) => { received = message; };
    (hub as any).udsPath = udsPath;
    await (hub as any).connectToWorker();
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(received).toMatchObject({ input: '中文输入不会变成乱码' });
    hub.stop();
    (hub as any).handleWorkerMessage = originalHandleWorkerMessage;
    (hub as any).udsPath = originalUdsPath;
    server.unref();
    server.close();
  });

  it('preserves Chinese user turns when an HTTP request body splits inside a character', async () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'utf8-http-agent';
    const session = worker.getOrCreateSession(agentId, 'UTF-8 HTTP Agent');
    session.clientId = 'client-1';
    (worker as any).udsClients.set('client-1', { write() {} });
    const request = new PassThrough();
    const response = createResponse();

    (worker as any).handlePostUserTurn(request, response, agentId);
    const [first, second] = splitInsideChineseCharacter(JSON.stringify({ text: '中文输入不会变成乱码' }));
    request.write(first);
    request.end(second);
    await once(request, 'end');

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ success: true, delivery: 'queued' });
    expect(session.queuedInputs).toMatchObject([{ text: '中文输入不会变成乱码' }]);
  });
});
