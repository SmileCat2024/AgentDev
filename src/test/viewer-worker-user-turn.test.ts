import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ViewerWorker } from '../core/viewer-worker.js';

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-user-turn-${process.pid}-${Date.now()}-${Math.random()}`;
  }
  return `/tmp/agentdev-user-turn-${process.pid}-${Date.now()}-${Math.random()}.sock`;
}

function createWorker(agentId = 'user-turn-agent') {
  const worker = new ViewerWorker(0, false, getTestUdsPath());
  const session = worker.getOrCreateSession(agentId, 'User Turn Agent');
  session.clientId = 'client-1';
  (worker as any).udsClients.set('client-1', {
    write() {},
  });
  return { worker, session, agentId };
}

describe('ViewerWorker user-turn contract', () => {
  it('atomically resolves a compatible pending text request', () => {
    const { worker, session, agentId } = createWorker();
    (session as any).pendingInputRequests = new Map([
      ['input-waiting', { prompt: '请输入', mode: 'text' }],
    ]);
    const writes: string[] = [];
    (worker as any).udsClients.set('client-1', {
      write(message: string) { writes.push(message); },
    });

    const result = worker.submitUserTurn(agentId, {
      text: 'from a generated component',
      images: [{ path: '/tmp/example.png', mediaType: 'image/png' }],
      source: 'generative-ui',
      sourceRef: 'event-1',
    });

    expect(result).toEqual({
      success: true,
      delivery: 'input',
      requestId: 'input-waiting',
      source: 'generative-ui',
      sourceRef: 'event-1',
    });
    expect((session as any).pendingInputRequests.size).toBe(0);
    expect(session.queuedInputs).toHaveLength(0);
    expect(writes).toHaveLength(1);
    const delivered = JSON.parse(writes[0]);
    expect(delivered.type).toBe('input-response');
    expect(delivered.response.kind).toBe('text');
    expect(delivered.response.payload.images).toHaveLength(1);
    expect(delivered.response.payload.source).toBe('generative-ui');
    expect(delivered.response.payload.sourceRef).toBe('event-1');
  });

  it('queues a new turn when no input request is pending', () => {
    const { worker, session, agentId } = createWorker();
    session.callActive = true;

    const result = worker.submitUserTurn(agentId, {
      text: 'follow-up',
      source: 'chat-composer',
    });

    expect(result.success).toBe(true);
    expect(result.delivery).toBe('queued');
    expect(session.queuedInputs).toHaveLength(1);
    expect(session.queuedInputs[0]).toMatchObject({
      text: 'follow-up',
      source: 'chat-composer',
    });
  });

  it('rejects an idle runtime instead of accepting an input that cannot be consumed', () => {
    const { worker, session, agentId } = createWorker();

    const result = worker.submitUserTurn(agentId, {
      text: 'do not leave me stuck',
      source: 'generative-ui',
    });

    expect(result).toEqual({
      success: false,
      code: 'runtime_not_accepting_input',
      error: 'Agent runtime has no active call or compatible input request',
    });
    expect(session.queuedInputs).toHaveLength(0);
  });

  it('hands a late queued turn to the next compatible input request', () => {
    const { worker, session, agentId } = createWorker();
    session.callActive = true;
    worker.submitUserTurn(agentId, {
      text: 'arrived during call shutdown',
      images: [{ path: '/tmp/late.png', mediaType: 'image/png' }],
      source: 'voice-input',
      sourceRef: 'voice-1',
    });
    session.callActive = false;

    const writes: string[] = [];
    (worker as any).udsClients.set('client-1', {
      write(message: string) { writes.push(message); },
    });
    worker.handleRequestInput({
      agentId,
      requestId: 'next-input',
      prompt: '请输入',
      mode: 'text',
    });

    expect(session.queuedInputs).toHaveLength(0);
    expect((session as any).pendingInputRequests.size).toBe(0);
    const delivered = JSON.parse(writes[0]);
    expect(delivered.requestId).toBe('next-input');
    expect(delivered.response.text).toBe('arrived during call shutdown');
    expect(delivered.response.payload.images).toHaveLength(1);
    expect(delivered.response.payload.source).toBe('voice-input');
    expect(delivered.response.payload.sourceRef).toBe('voice-1');
  });

  it('rejects a new text turn while an incompatible choice request is pending', () => {
    const { worker, session, agentId } = createWorker();
    (session as any).pendingInputRequests = new Map([
      ['choice-waiting', { prompt: '请选择', mode: 'choices' }],
    ]);

    const result = worker.submitUserTurn(agentId, {
      text: 'must not get stuck',
      source: 'remote-claw',
    });

    expect(result).toEqual({
      success: false,
      code: 'input_mode_conflict',
      error: 'A non-text interactive input request must be completed before submitting a new user turn',
      pendingMode: 'choices',
    });
    expect(session.queuedInputs).toHaveLength(0);
  });

  it('gives an incompatible request precedence when pending requests overlap', () => {
    const { worker, session, agentId } = createWorker();
    (session as any).pendingInputRequests = new Map([
      ['text-waiting', { prompt: '请输入', mode: 'text' }],
      ['choice-waiting', { prompt: '请选择', mode: 'choices' }],
    ]);

    const result = worker.submitUserTurn(agentId, { text: 'new turn' });

    expect(result.success).toBe(false);
    expect(result.code).toBe('input_mode_conflict');
    expect((session as any).pendingInputRequests.size).toBe(2);
  });

  it('exposes the same delivery contract through the HTTP handler', () => {
    const { worker, session, agentId } = createWorker();
    (session as any).pendingInputRequests = new Map([
      ['http-input', { prompt: '请输入' }],
    ]);
    const req = new EventEmitter();
    let status = 0;
    let body = '';
    const res = {
      writeHead(code: number) { status = code; },
      end(value: string) { body = value; },
    };

    (worker as any).handlePostUserTurn(req, res, agentId);
    req.emit('data', Buffer.from(JSON.stringify({ text: 'http turn', source: 'test' })));
    req.emit('end');

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      success: true,
      delivery: 'input',
      requestId: 'http-input',
      source: 'test',
    });
  });
});
