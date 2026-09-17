import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';

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

  it('rejects input delivery without a runtime client instead of broadcasting', () => {
    const { worker, session, agentId } = createWorker();
    const writes: string[] = [];
    session.inputLease = { requestId: 'missing-client', prompt: '请输入', mode: 'text', timestamp: Date.now() };
    delete session.clientId;
    (worker as any).udsClients.set('other-client', {
      write(message: string) { writes.push(message); },
    });

    const result = worker.submitUserTurn(agentId, {
      text: 'must not reach another runtime',
      source: 'chat-composer',
    });

    expect(result).toEqual({
      success: false,
      code: 'runtime_not_accepting_input',
      error: 'Agent runtime is not connected',
    });
    expect(session.inputLease).toMatchObject({ requestId: 'missing-client' });
    expect(writes).toHaveLength(0);
  });

  it('does not report interrupt success when the runtime client is missing', () => {
    const { worker, session, agentId } = createWorker();
    delete session.clientId;
    let status = 0;
    let body = '';
    const res = {
      writeHead(code: number) { status = code; },
      end(value: string) { body = value; },
    };

    (worker as any).handleInterrupt({} as any, res as any, agentId);

    expect(status).toBe(409);
    expect(JSON.parse(body)).toEqual({
      success: false,
      code: 'runtime_not_accepting_input',
      error: 'Agent runtime is not connected',
    });
  });

  it('rejects current logs without an explicit runtime target', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    let status = 0;
    let body = '';
    const res = {
      writeHead(code: number) { status = code; },
      end(value: string) { body = value; },
    };

    (worker as any).handleGetLogs({} as any, res as any, new URLSearchParams('scope=current'));

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({
      success: false,
      code: 'invalid_target',
      error: 'agentId query parameter is required for current logs',
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

  it('clears the matching lease when the runtime cancels an input request', () => {
    const { worker, session, agentId } = createWorker();
    session.inputLease = { requestId: 'stale-choice', prompt: '请选择', mode: 'choices', timestamp: Date.now() };

    worker.handleInputRequestCancelled({ type: 'input-request-cancelled', agentId, requestId: 'stale-choice' });

    expect(session.inputLease).toBeUndefined();
    // 中断取消后，新 user-turn 不再被陈旧 choices 租约以 input_mode_conflict 拒绝
    const result = worker.submitUserTurn(agentId, { text: 'finally goes through', source: 'chat-composer' });
    expect(result).toMatchObject({ success: true, delivery: 'queued' });
  });

  it('does not clear a newer lease when cancelling a stale request id', () => {
    const { worker, session, agentId } = createWorker();
    session.inputLease = { requestId: 'reopened-text', prompt: '请输入', mode: 'text', timestamp: Date.now() };

    worker.handleInputRequestCancelled({ type: 'input-request-cancelled', agentId, requestId: 'stale-choice' });

    expect(session.inputLease).toMatchObject({ requestId: 'reopened-text', mode: 'text' });
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

  it('delivers free-form metadata to the runtime with a direct lease response', () => {
    const { worker, session, agentId } = createWorker();
    session.inputLease = { requestId: 'meta-input', prompt: '请输入', mode: 'text', timestamp: Date.now() };
    const writes: string[] = [];
    (worker as any).udsClients.set('client-1', {
      write(message: string) { writes.push(message); },
    });

    const metadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-1', title: '修复登录超时' }] };
    const result = worker.submitUserTurn(agentId, { text: 'with metadata', source: 'chat-composer', metadata });

    expect(result.success).toBe(true);
    expect(result.delivery).toBe('input');
    const delivered = JSON.parse(writes[0]);
    expect(delivered.response.payload.metadata).toEqual(metadata);
  });

  it('preserves metadata when a turn goes through the runtime mailbox', () => {
    const { worker, session, agentId } = createWorker();
    session.callActive = true;
    const metadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-2', title: '重构导出逻辑' }] };

    const result = worker.submitUserTurn(agentId, { text: 'queued with metadata', source: 'chat-composer', metadata });

    expect(result).toMatchObject({ success: true, delivery: 'queued' });
    expect(session.queuedInputs[0].metadata).toEqual(metadata);

    // 邮箱转交给下一个 lease 时 metadata 原样随行
    const writes: string[] = [];
    (worker as any).udsClients.set('client-1', {
      write(message: string) { writes.push(message); },
    });
    worker.handleRequestInput({ agentId, requestId: 'next-input', prompt: '请输入', mode: 'text' });
    expect(session.queuedInputs).toHaveLength(0);
    const delivered = JSON.parse(writes[0]);
    expect(delivered.response.payload.metadata).toEqual(metadata);
  });

  it('rejects malformed metadata shapes', () => {
    const { worker, session, agentId } = createWorker();
    session.callActive = true;

    const arrayForm = worker.submitUserTurn(agentId, { text: 'bad', source: 'test', metadata: ['not', 'an', 'object'] as unknown as Record<string, unknown> });
    expect(arrayForm).toMatchObject({ success: false, code: 'invalid_input' });

    const oversized = worker.submitUserTurn(agentId, {
      text: 'bad',
      source: 'test',
      metadata: { blob: 'x'.repeat(20000) },
    });
    expect(oversized).toMatchObject({ success: false, code: 'invalid_input' });
    expect(session.queuedInputs).toHaveLength(0);
  });

  it('skips metadata-bearing queued inputs for in-call dequeue while keeping them for lease handoff', async () => {
    const { worker, session, agentId } = createWorker();
    session.callActive = true;
    worker.submitUserTurn(agentId, {
      text: 'plain queued turn',
      source: 'chat-composer',
    });
    worker.submitUserTurn(agentId, {
      text: 'turn with metadata',
      source: 'chat-composer',
      metadata: { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-x', title: '引用' }] },
    });
    session.callActive = false;

    const dequeue = async (body: string) => {
      const req = new EventEmitter() as any;
      req.setEncoding = () => {};
      const chunks: string[] = [];
      await Promise.resolve();
      const done = Promise.resolve().then(() => {
        (worker as any).handleDequeueInput(req, {
          writeHead() {},
          end(payload: string) { chunks.push(String(payload)); },
        } as any, agentId);
        req.emit('data', body);
        req.emit('end');
      });
      await done;
      await new Promise((r) => setTimeout(r, 0));
      return chunks.length > 0 ? JSON.parse(chunks[chunks.length - 1]) : null;
    };

    // skipMetadata：跳过带 metadata 的项，只取无 metadata 的
    const skipped = await dequeue(JSON.stringify({ skipMetadata: true }));
    expect(skipped.input.text).toBe('plain queued turn');
    expect(session.queuedInputs).toHaveLength(1);
    expect(session.queuedInputs[0].text).toBe('turn with metadata');

    // 再取 skipMetadata：仅剩 metadata 项，返回 null 不消费
    const none = await dequeue(JSON.stringify({ skipMetadata: true }));
    expect(none.input).toBeNull();
    expect(session.queuedInputs).toHaveLength(1);

    // 默认（宿主 drain）：拿全部，含 metadata
    const drained = await dequeue('{}');
    expect(drained.input.text).toBe('turn with metadata');
    expect(drained.input.metadata?.['session-reference']).toHaveLength(1);
    expect(session.queuedInputs).toHaveLength(0);
  });
});
