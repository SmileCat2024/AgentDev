/**
 * ViewerWorker queued-input-available 通知契约（空闲消费加速信号）。
 *
 * 背景：ADR-0047 后带身份的 durable command 不走 lease 直答，空闲态消费
 * 的唯一触发原是消费方 1s 轮询——交互会话空闲发送时输入在队列停留
 * 0.5–1s（排队气泡闪现）。ViewerWorker 作为队列事实的唯一持有方，在
 * 输入**入队落盘成功之后**经 runtime 的 UDS 连接下发纯加速信号。
 *
 * 承诺：
 * - 排队路径（delivery: 'queued'）在返回 success 前向该 runtime 的 UDS
 *   socket 写一帧 {type:'queued-input-available', agentId}（JSON 行）；
 * - 信号不携带队列数据（长度、内容、commandId 一律不含）——消费仍走
 *   claim/dequeue 完整协议，本帧只是把下一次轮询提前；
 * - lease 直答路径（delivery: 'input'）不通知——输入已被消费，无排队事实；
 * - runtime 未连接（无 clientId / socket 不在）时静默跳过，不抛错：
 *   通知只影响延迟，丢失由消费方轮询兜底。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-queued-notify-${process.pid}-${Date.now()}-${Math.random()}`;
  }
  return `/tmp/agentdev-queued-notify-${process.pid}-${Date.now()}-${Math.random()}.sock`;
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentdev-queued-notify-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type RecordedSocket = { writes: string[] };

function createWorkerWithSocket(agentId = 'notify-agent', opts?: { durable?: boolean }) {
  const worker = new ViewerWorker(0, false, getTestUdsPath(), opts?.durable ? { queuedInputStoreDir: root } : undefined);
  const session = worker.getOrCreateSession(agentId, 'Notify Agent');
  session.clientId = 'client-1';
  const socket: RecordedSocket = { writes: [] };
  (worker as any).udsClients.set('client-1', {
    write(message: string) { socket.writes.push(message); },
  });
  return { worker, session, agentId, socket };
}

function parseFrames(socket: RecordedSocket): any[] {
  return socket.writes
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe('ViewerWorker queued-input-available notification', () => {
  it('writes the signal frame on the queued path before returning success', () => {
    const { worker, session, agentId, socket } = createWorkerWithSocket('notify-durable-agent', { durable: true });
    // 真实形态：ph 空闲发送 = 线程命令（ADR-0047 身份链），会话身份匹配才被接收
    session.threadId = 'thread-n';
    session.headGeneration = 1;
    session.workSessionId = 'ws-n';

    const result = worker.submitUserTurn(agentId, {
      text: 'idle-send command',
      source: 'thread',
      sourceRef: 'cmd-n1',
      sessionId: 'ws-n',
      commandIdentity: { commandId: 'cmd-n1', threadId: 'thread-n', headGeneration: 1 },
    });

    expect(result).toMatchObject({ success: true, delivery: 'queued' });
    const frames = parseFrames(socket).filter((frame) => frame.type === 'queued-input-available');
    expect(frames).toHaveLength(1);
    expect(frames[0].agentId).toBe(agentId);
    // 纯信号：除 type/agentId 外不得携带任何队列数据
    expect(Object.keys(frames[0]).sort()).toEqual(['agentId', 'type']);
  });

  it('does not notify on the lease direct-answer path (input already consumed)', () => {
    const { worker, session, agentId, socket } = createWorkerWithSocket();
    session.inputLease = { requestId: 'lease-open', prompt: '输入', mode: 'text', timestamp: Date.now() };

    const result = worker.submitUserTurn(agentId, { text: 'lease answered' });

    expect(result).toMatchObject({ success: true, delivery: 'input' });
    const frames = parseFrames(socket).filter((frame) => frame.type === 'queued-input-available');
    expect(frames).toHaveLength(0);
  });

  it('keeps the enqueue fact intact when the notify write fails', () => {
    // socket 在（isSessionConnected 通过、输入被接收）但 write 抛异常：
    // 通知失败只损失加速，不得影响入队事实——消费方轮询兜底仍能取到。
    // （socket 不在的形态在 submitUserTurn 入口就被拒收，通知路径不可达。）
    const { worker, session, agentId } = createWorkerWithSocket();
    (worker as any).udsClients.set('client-1', {
      write() { throw new Error('EPIPE'); },
    });

    expect(() => worker.submitUserTurn(agentId, { text: 'broken pipe', source: 'thread' }))
      .not.toThrow();
    expect(session.queuedInputs).toHaveLength(1); // 入队事实不受通知失败影响
  });

  it('notifies again for each enqueue (one frame per queued input)', () => {
    const { worker, agentId, socket } = createWorkerWithSocket();

    worker.submitUserTurn(agentId, { text: 'first', source: 'thread' });
    worker.submitUserTurn(agentId, { text: 'second', source: 'thread' });

    const frames = parseFrames(socket).filter((frame) => frame.type === 'queued-input-available');
    expect(frames).toHaveLength(2);
  });
});
