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
    session.inputLease = { requestId: 'input-waiting', prompt: '请输入', mode: 'text', timestamp: Date.now() };
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
    expect(session.inputLease).toBeUndefined();
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

  it('stores a startup turn in the runtime mailbox before a lease opens', () => {
    const { worker, session, agentId } = createWorker();

    const result = worker.submitUserTurn(agentId, {
      text: 'first message after resume',
      source: 'generative-ui',
    });

    expect(result).toMatchObject({ success: true, delivery: 'queued', queueLength: 1 });
    expect(session.queuedInputs).toMatchObject([{ text: 'first message after resume' }]);
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
    expect(session.inputLease).toBeUndefined();
    const delivered = JSON.parse(writes[0]);
    expect(delivered.requestId).toBe('next-input');
    expect(delivered.response.text).toBe('arrived during call shutdown');
    expect(delivered.response.payload.images).toHaveLength(1);
    expect(delivered.response.payload.source).toBe('voice-input');
    expect(delivered.response.payload.sourceRef).toBe('voice-1');
  });

  it('rejects a new text turn while an incompatible choice request is pending', () => {
    const { worker, session, agentId } = createWorker();
    session.inputLease = { requestId: 'choice-waiting', prompt: '请选择', mode: 'choices', timestamp: Date.now() };

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

  it('replaces a stale lease instead of accumulating multiple input cards', () => {
    const { worker, session, agentId } = createWorker();
    worker.handleRequestInput({ agentId, requestId: 'old-text', prompt: 'old', mode: 'text' });
    worker.handleRequestInput({ agentId, requestId: 'current-choice', prompt: 'new', mode: 'choices' });

    expect(session.inputLease).toMatchObject({ requestId: 'current-choice', mode: 'choices' });
  });

  it('exposes the same delivery contract through the HTTP handler', () => {
    const { worker, session, agentId } = createWorker();
    session.inputLease = { requestId: 'http-input', prompt: '请输入', timestamp: Date.now() };
    const req = new EventEmitter() as EventEmitter & { setEncoding: (encoding: BufferEncoding) => void };
    req.setEncoding = () => {};
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

  it('stores the input policy declared at registration', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    worker.handleRegisterAgent({
      agentId: 'sealed-agent',
      name: 'Sealed Runtime',
      inputPolicy: 'none',
    });

    const session = worker.getOrCreateSession('sealed-agent', 'Sealed Runtime');
    expect(session.inputPolicy).toBe('none');

    // 默认注册不设置策略：外部输入保持既有行为
    worker.handleRegisterAgent({ agentId: 'open-agent', name: 'Open Runtime' });
    const openSession = worker.getOrCreateSession('open-agent', 'Open Runtime');
    expect(openSession.inputPolicy).toBeUndefined();
  });

  it('rejects queued user turns for runtimes sealed against external input', () => {
    const { worker, session, agentId } = createWorker();
    session.inputPolicy = 'none';
    session.callActive = true;

    const result = worker.submitUserTurn(agentId, {
      text: 'must not enter the mailbox',
      source: 'chat-composer',
    });

    expect(result).toEqual({
      success: false,
      code: 'runtime_not_accepting_input',
      error: 'This runtime does not accept external user turns',
    });
    expect(session.queuedInputs).toHaveLength(0);
  });

  it('keeps input leases feature-driven even under a sealed mailbox policy', () => {
    const { worker, session, agentId } = createWorker();
    session.inputPolicy = 'none';
    session.inputLease = { requestId: 'feature-requested', prompt: '请输入', mode: 'text', timestamp: Date.now() };
    const writes: string[] = [];
    (worker as any).udsClients.set('client-1', {
      write(message: string) { writes.push(message); },
    });

    const result = worker.submitUserTurn(agentId, { text: 'lease reply', source: 'chat-composer' });

    expect(result.success).toBe(true);
    expect(result.delivery).toBe('input');
    expect(writes).toHaveLength(1);
  });
});
