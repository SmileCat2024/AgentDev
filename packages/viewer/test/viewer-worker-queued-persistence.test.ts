import { mkdtemp, rm, readdir, writeFile, writeFile as wf } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';

/**
 * ADR-0047 阶段 3a：排队输入持久接管 + 接收端 sourceRef 幂等去重。
 *
 * 承诺（对应 ADR §「runtime 已接收待处理」层；阶段 3 审查裁定后的精确边界）：
 * - 启用 storeDir 时，排队输入在返回 success 前持久落盘；worker 重启
 *   （新实例、同目录）后队列恢复——接收后崩溃不丢失。写盘失败 =
 *   未接收：返回 retryable 失败并回滚内存，投递方重试（不静默成功）。
 * - 消费边界：先持久化「移除 + 消费记录」成功，才转交/移除内存；写盘
 *   失败输入原地保留，不产生重复执行窗口。
 * - 带 sourceRef 的重复投递幂等：未消费 → 返回既有排队项（duplicate）；
 *   已消费 → 幂等成功（delivery consumed），不重新执行。去重检查在
 *   lease 直接应答之前（重复投递遇活动 lease 不得绕过两层去重）。
 * - consumedSourceRefs 是有界去重窗口（500 条）：超窗重投会重新入队。
 *   无条件幂等的权威防线在 WorkThread Inbox（delivered 命令不重投）。
 * - 未启用 storeDir 的宿主行为不变（内存队列、无去重）。
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-queued-persist-${process.pid}-${Date.now()}-${Math.random()}`;
  }
  return `/tmp/agentdev-queued-persist-${process.pid}-${Date.now()}-${Math.random()}.sock`;
}

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentdev-queued-persist-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function createWorker(agentId: string, storeDir?: string) {
  const worker = new ViewerWorker(0, false, getTestUdsPath(), storeDir ? { queuedInputStoreDir: storeDir } : undefined);
  const session = worker.getOrCreateSession(agentId, 'Persist Agent');
  session.clientId = 'client-1';
  (worker as any).udsClients.set('client-1', { write() {} });
  return { worker, session, agentId };
}

/** 真实 dequeue 端点处理器调用（审查裁定：不得绕过真实消费路径）。 */
function claimViaMethod(worker: ViewerWorker, agentId: string) {
  return worker.claimCommandInput(agentId);
}

function ackViaMethod(worker: ViewerWorker, agentId: string, receipt: any) {
  return worker.acknowledgeCommandInput(agentId, receipt);
}

function dequeueViaHandler(worker: ViewerWorker, agentId: string) {
  let status = 0;
  let body = '';
  const res: any = {
    writeHead(code: number) { status = code; },
    end(payload: string) { body = payload; },
  };
  (worker as any).handleDequeueInput({ resume() {} } as any, res, agentId);
  return { status, body: JSON.parse(body || '{}') };
}

describe('ViewerWorker queued-input persistence (ADR-0047 stage 3a)', () => {
  it('persists queued inputs to disk and restores them in a fresh worker instance (restart recovery)', async () => {
    const dir = join(root, 'restore');
    const first = createWorker('persist-agent-1', dir);
    first.session.callActive = true;
    const result = first.worker.submitUserTurn('persist-agent-1', {
      text: 'recover me',
      source: 'thread',
      sourceRef: 'cmd-recover-1',
    });
    expect(result).toMatchObject({ success: true, delivery: 'queued' });

    // 落盘可见（per-agent 文件）
    const files = await readdir(join(dir, 'queued-inputs'));
    expect(files.some((f) => f.startsWith('persist-agent-1'))).toBe(true);

    // 新 worker 实例（同目录）= 重启：会话建立时队列恢复
    const second = createWorker('persist-agent-1', dir);
    expect(second.session.queuedInputs).toHaveLength(1);
    expect(second.session.queuedInputs[0]?.text).toBe('recover me');
    expect(second.session.queuedInputs[0]?.sourceRef).toBe('cmd-recover-1');
  });

  it('binds durable input fencing from Claw registration metadata, not the Viewer session key', () => {
    const { worker, session, agentId } = createWorker('registration-identity');
    (worker as any).handleRegisterAgent({
      agentId,
      name: 'registered agent',
      sessionId: 'viewer-runtime-key',
      metadata: {
        workSessionId: 'claw-business-session',
        runtimeInstanceId: 'runtime-registered',
        threadId: 'thread-registered',
        headGeneration: 5,
      },
    }, 'client-1');
    expect(session.id).toBe(agentId);
    expect(session.workSessionId).toBe('claw-business-session');
    expect(session.runtimeInstanceId).toBe('runtime-registered');
    expect(session.threadId).toBe('thread-registered');
    expect(session.headGeneration).toBe(5);
  });

  it('binds durable input fencing from top-level RegisterAgentMsg fields (UDS DebugHub contract)', () => {
    // DebugHub UDS 发送端按 RegisterAgentMsg 契约把身份展开在消息顶层
    // （claw transport 之外的真实 runtime 路径）。只读 msg.metadata 会让
    // 身份静默丢失，WorkThread fencing 拒绝一切线程指令（阶段 5 真实宿主
    // 联测捕获的错配）。
    const { worker, session, agentId } = createWorker('registration-identity-top-level');
    (worker as any).handleRegisterAgent({
      type: 'register-agent',
      agentId,
      name: 'uds registered agent',
      runtimeInstanceId: 'runtime-uds',
      threadId: 'thread-uds',
      headGeneration: 2,
      workSessionId: 'session-uds',
    }, 'client-1');
    expect(session.runtimeInstanceId).toBe('runtime-uds');
    expect(session.threadId).toBe('thread-uds');
    expect(session.headGeneration).toBe(2);
    expect(session.workSessionId).toBe('session-uds');
  });

  it('rejects WorkThread commands instead of silently using an in-memory queue', () => {
    const { worker, session, agentId } = createWorker('thread-memory-reject');
    session.threadId = 'thread-1';
    session.headGeneration = 3;
    session.workSessionId = 'session-1';
    session.runtimeInstanceId = 'runtime-1';
    session.callActive = true;
    const result = worker.submitUserTurn(agentId, {
      text: 'durable command',
      sessionId: 'session-1',
      commandIdentity: { commandId: 'cmd-1', threadId: 'thread-1', headGeneration: 3 },
    });
    expect(result).toMatchObject({ success: false, code: 'persistent_store_unavailable', retryable: true });
    expect(session.queuedInputs).toHaveLength(0);
  });

  it('deduplicates a retried submit by sourceRef while the input is still queued (no double execution)', () => {
    const { worker, session, agentId } = createWorker('dedupe-agent-1', join(root, 'dedupe'));
    session.callActive = true;
    const first = worker.submitUserTurn(agentId, {
      text: 'do work', source: 'thread', sourceRef: 'cmd-dedupe-1',
    });
    expect(first).toMatchObject({ success: true, delivery: 'queued' });
    expect((first as { duplicate?: boolean }).duplicate).toBeUndefined();

    // 投递方标记 delivered 前崩溃 → 重试同一 commandId：幂等返回既有排队项
    const retry = worker.submitUserTurn(agentId, {
      text: 'do work', source: 'thread', sourceRef: 'cmd-dedupe-1',
    });
    expect(retry).toMatchObject({ success: true, delivery: 'queued', duplicate: true, id: (first as { id: string }).id });
    expect(session.queuedInputs).toHaveLength(1);
  });

  it('deduplicates before the active input lease path (duplicate delivery must not bypass dedup)', () => {
    const { worker, session, agentId } = createWorker('lease-dedupe-agent', join(root, 'lease-dedupe'));
    session.callActive = true;
    worker.submitUserTurn(agentId, { text: 'first', source: 'thread', sourceRef: 'cmd-lease-1' });
    // 活动文本 lease：正常新输入会被直接转交，重复投递必须先命中去重
    (session as any).inputLease = { requestId: 'req-1', mode: 'text', prompt: 'p', timestamp: Date.now() };
    const retry = worker.submitUserTurn(agentId, { text: 'first', source: 'thread', sourceRef: 'cmd-lease-1' });
    expect(retry).toMatchObject({ success: true, delivery: 'queued', duplicate: true });
    // lease 未被消费（转交未发生），队列保持 1 项
    expect((session as any).inputLease?.requestId).toBe('req-1');
    expect(session.queuedInputs).toHaveLength(1);
  });

  it('returns consumed idempotency for a sourceRef consumed via the real dequeue handler (survives restart)', async () => {
    const dir = join(root, 'consumed');
    const first = createWorker('consumed-agent-1', dir);
    first.session.callActive = true;
    first.worker.submitUserTurn('consumed-agent-1', {
      text: 'once only', source: 'thread', sourceRef: 'cmd-once-1',
    });

    // 真实 dequeue 端点路径：写盘成功才消费（先持久化后移除）
    const { status, body } = dequeueViaHandler(first.worker, 'consumed-agent-1');
    expect(status).toBe(200);
    expect(body.input?.sourceRef).toBe('cmd-once-1');
    expect(first.session.queuedInputs).toHaveLength(0);

    // 已消费重试：幂等成功，不重新入队
    const retry = first.worker.submitUserTurn('consumed-agent-1', {
      text: 'once only', source: 'thread', sourceRef: 'cmd-once-1',
    });
    expect(retry).toMatchObject({ success: true, delivery: 'consumed', duplicate: true });
    expect(first.session.queuedInputs).toHaveLength(0);

    // 重启后去重记录仍有效（consumedSourceRefs 持久化）
    const second = createWorker('consumed-agent-1', dir);
    const retryAfterRestart = second.worker.submitUserTurn('consumed-agent-1', {
      text: 'once only', source: 'thread', sourceRef: 'cmd-once-1',
    });
    expect(retryAfterRestart).toMatchObject({ success: true, delivery: 'consumed', duplicate: true });
  });

  it('fails the submit (retryable) when the store write fails, keeping memory and disk unreceived', async () => {
    // storeDir 指向一个普通文件 → mkdir 子目录必然 ENOTDIR：真实写失败路径
    const blocker = join(root, 'blocker-file');
    await wf(blocker, 'not a directory', 'utf8');
    const { worker, session, agentId } = createWorker('storefail-agent', blocker);
    session.callActive = true;
    const result = worker.submitUserTurn(agentId, { text: 'x', source: 'thread', sourceRef: 'cmd-storefail-1' });
    expect(result).toMatchObject({
      success: false,
      code: 'persistent_store_unavailable',
      retryable: true,
    });
    // 接收边界收敛：内存回滚，未入队（投递方重试时不会叠加重复项）
    expect(session.queuedInputs).toHaveLength(0);
  });

  it('keeps the queued input unconsumed (503) when the consume-time store write fails, and the item survives restart', async () => {
    const dir = join(root, 'consumefail');
    const { worker, session, agentId } = createWorker('consumefail-agent', dir);
    session.callActive = true;
    worker.submitUserTurn(agentId, { text: 'y', source: 'thread', sourceRef: 'cmd-consumefail-1' });

    // 入队成功后把 storeDir 换成坏路径：dequeue 的移除预写失败
    (worker as any).queuedInputStoreDir = join(root, 'blocker-file-2');
    await wf(join(root, 'blocker-file-2'), 'x', 'utf8');
    const { status } = dequeueViaHandler(worker, agentId);
    expect(status).toBe(503);
    // 输入原地保留（内存与磁盘一致），不产生重复执行窗口
    expect(session.queuedInputs).toHaveLength(1);

    // 磁盘未被动过：重启后（新实例、恢复原 storeDir）该项仍在队列
    const second = createWorker('consumefail-agent', dir);
    expect(second.session.queuedInputs).toHaveLength(1);
    expect(second.session.queuedInputs[0]?.sourceRef).toBe('cmd-consumefail-1');
  });

  it('recovers by requeue from the dequeue crash end-state: item removed from disk before the response, ref unrecorded', () => {
    // dequeue 路径崩溃终态（预写成功后、响应送达 runtime 前崩溃）：
    // 磁盘 items 无该项 + 引用未记。新实例重启后重投必须重新入队
    // （不命中 consumed 幂等）——Viewer 侧任何时点崩溃不产生丢且不可重发。
    const dir = join(root, 'dequeue-crash-endstate');
    const first = createWorker('dequeue-crash-agent', dir);
    first.session.callActive = true;
    first.worker.submitUserTurn('dequeue-crash-agent', { text: 'z', source: 'thread', sourceRef: 'cmd-dqcrash-1' });
    // 构造终态：磁盘 items 清空、引用不记（模拟移除预写后崩溃）
    (first.worker as any).saveQueuedInputState('dequeue-crash-agent', [], []);

    const second = createWorker('dequeue-crash-agent', dir);
    expect(second.session.queuedInputs).toHaveLength(0);
    const resubmit = second.worker.submitUserTurn('dequeue-crash-agent', {
      text: 'z', source: 'thread', sourceRef: 'cmd-dqcrash-1',
    });
    expect(resubmit).toMatchObject({ success: true, delivery: 'queued' });
    expect((resubmit as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect(second.session.queuedInputs).toHaveLength(1);
  });

  it('documents the bounded dedup window: an evicted consumed ref re-enters the queue on resubmit', () => {
    // 有界窗口语义锁定（审查裁定 2）：500 条淘汰后旧 ref 重投重新入队。
    // 这是有意取舍——无条件幂等的权威防线在 Inbox 状态机（delivered 不
    // 重投）；接收端窗口只覆盖常规重试窗口。
    const dir = join(root, 'eviction');
    const { worker, agentId } = createWorker('eviction-agent', dir);
    // 真实演化的终态：窗口满 500 条（cmd-old-1..500），cmd-old-0 已被淘汰
    const refs = Array.from({ length: 500 }, (_, i) => `cmd-old-${i + 1}`);
    (worker as any).saveQueuedInputState(agentId, [], refs);
    const restored = (worker as any).loadQueuedInputState(agentId);
    expect(restored.consumedSourceRefs).toHaveLength(500);
    expect(restored.consumedSourceRefs).not.toContain('cmd-old-0'); // 已在窗口外

    (worker as any).getOrCreateSession(agentId, 'x').callActive = true;
    const resubmit = worker.submitUserTurn(agentId, {
      text: 'again', source: 'thread', sourceRef: 'cmd-old-0',
    });
    expect(resubmit).toMatchObject({ success: true, delivery: 'queued' });
    expect((resubmit as { duplicate?: boolean }).duplicate).toBeUndefined();
  });

  it('recovers by requeue when the lease handoff prewrite succeeds but forwarding fails (salvage write succeeds)', () => {
    // 二轮审查核心边界路径 1：预写成功（items 移除、引用未记）+ 转交
    // 失败 + 补救写成功 → 磁盘恢复原项、消费引用不在记录中 → 重投
    // 必须重新入队（不得返回 consumed 造成丢且不可重发）。
    const dir = join(root, 'lease-crash');
    const { worker, session, agentId } = createWorker('lease-crash-agent', dir);
    session.callActive = true;
    worker.submitUserTurn(agentId, { text: 'handoff me', source: 'thread', sourceRef: 'cmd-leasecrash-1' });
    expect(session.queuedInputs).toHaveLength(1);

    // 转交失败：clientId 指向未注册的连接 → forwardInputResponse false
    session.clientId = 'not-connected';
    (worker as any).handleRequestInput({ agentId, requestId: 'req-x', mode: 'text', prompt: 'p' });

    // 补救写已恢复磁盘原项；消费引用绝不在记录中（预写不记、补记
    // 只在转交成功后发生）
    const { consumedSourceRefs } = (worker as any).loadQueuedInputState(agentId);
    expect(consumedSourceRefs).not.toContain('cmd-leasecrash-1');

    // 重投同一 commandId：命中队列内去重（原项仍在队列，幂等返回既有
    // 项，不叠加副本也不返回 consumed——项未丢失）
    session.clientId = 'client-1';
    const resubmit = worker.submitUserTurn(agentId, { text: 'handoff me', source: 'thread', sourceRef: 'cmd-leasecrash-1' });
    expect(resubmit).toMatchObject({ success: true, delivery: 'queued', duplicate: true });
    expect(session.queuedInputs).toHaveLength(1); // 原项保留，不叠加
  });

  it('recovers by requeue from the post-prewrite crash end-state: item removed from disk, ref unrecorded', () => {
    // 路径 2：预写成功后、转交前崩溃（或补救写也失败）的磁盘终态 =
    // items 无该项 + 消费引用未记。构造该终态后以新实例（= 重启）恢复，
    // 验证重投可重新入队——不丢且不可重发的窗口不存在。
    const dir = join(root, 'lease-crash-endstate');
    const first = createWorker('lease-crash-end-agent', dir);
    first.session.callActive = true;
    first.worker.submitUserTurn('lease-crash-end-agent', { text: 'lost item', source: 'thread', sourceRef: 'cmd-endstate-1' });
    // 构造终态：磁盘 items 清空、引用不记（模拟预写后崩溃）
    (first.worker as any).saveQueuedInputState('lease-crash-end-agent', [], []);

    // 重启恢复：内存队列来自磁盘（空）；重投重新入队
    const second = createWorker('lease-crash-end-agent', dir);
    expect(second.session.queuedInputs).toHaveLength(0);
    const resubmit = second.worker.submitUserTurn('lease-crash-end-agent', {
      text: 'lost item', source: 'thread', sourceRef: 'cmd-endstate-1',
    });
    expect(resubmit).toMatchObject({ success: true, delivery: 'queued' });
    expect((resubmit as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect(second.session.queuedInputs).toHaveLength(1);
  });

  it('clears the persisted queue via the real interrupt handler and allows redelivery of dropped refs', () => {
    const dir = join(root, 'interrupt-real');
    const { worker, agentId } = createWorker('interrupt-real-agent', dir);
    const session = (worker as any).getOrCreateSession(agentId, 'Real Interrupt');
    session.clientId = 'client-1';
    session.callActive = true;
    worker.submitUserTurn(agentId, { text: 'drop via handler', source: 'thread', sourceRef: 'cmd-idrop-1' });
    expect(session.queuedInputs).toHaveLength(1);

    // 真实 handleInterrupt 路径（不再是内层等价）：清内存 + 清持久队列 + 不记消费
    let status = 0;
    const res: any = { writeHead(code: number) { status = code; }, end() {} };
    (worker as any).handleInterrupt({ resume() {} } as any, res, agentId);
    expect(status).toBe(200);
    expect(session.queuedInputs).toHaveLength(0);
    const { consumedSourceRefs } = (worker as any).loadQueuedInputState(agentId);
    expect(consumedSourceRefs).not.toContain('cmd-idrop-1');

    // 重启恢复：队列为空；同 ref 重投是新的投递意图，可重新入队
    const second = createWorker('interrupt-real-agent', dir);
    expect(second.session.queuedInputs).toHaveLength(0);
    const resubmit = second.worker.submitUserTurn('interrupt-real-agent', {
      text: 'drop via handler', source: 'thread', sourceRef: 'cmd-idrop-1',
    });
    expect(resubmit).toMatchObject({ success: true, delivery: 'queued' });
    expect(second.session.queuedInputs).toHaveLength(1);
  });

  it('persists interrupt cancellation facts across restart: resubmission rejected, late ack cannot resurrect', () => {
    // ADR-0047 §6.3：cancel 先提交 → cancelled。取消事实必须跨重启持久：
    // 重启后同 commandId 重投仍被拒绝；claim 过但未 ack 的项被取消后，
    // 迟到 ack 不得把命令记为 consumed（ack 返回 false，消费集不收录）。
    const dir = join(root, 'cancel-persist');
    const { worker, session, agentId } = createWorker('cancel-persist-agent', dir);
    session.threadId = 'thread-cp';
    session.headGeneration = 2;
    session.workSessionId = 'ws-cp';
    session.runtimeInstanceId = 'rt-cp';
    session.callActive = true;
    const identity = { commandId: 'cmd-cp-1', threadId: 'thread-cp', headGeneration: 2 };
    expect(worker.submitUserTurn(agentId, {
      text: 'cancel me', sourceRef: 'cmd-cp-1', sessionId: 'ws-cp', commandIdentity: identity,
    })).toMatchObject({ success: true, delivery: 'queued' });

    // 已 claim、未 ack（中断截点的典型在场状态）
    const claimed = claimViaMethod(worker, agentId)!;
    expect(claimed.inputLease).toBeTruthy();

    let status = 0;
    let body = '';
    const res: any = { writeHead(code: number) { status = code; }, end(payload: string) { body = payload; } };
    (worker as any).handleInterrupt({ resume() {} } as any, res, agentId);
    expect(status).toBe(200);
    expect(JSON.parse(body).cancelledCommandIds).toEqual(['cmd-cp-1']);
    expect(session.queuedInputs).toHaveLength(0);
    expect((worker as any).loadQueuedInputState(agentId).cancelledCommandIds).toContain('cmd-cp-1');

    // 迟到 ack：命令已取消，不得复活为 consumed
    expect(ackViaMethod(worker, agentId, claimed.inputLease!)).toBe(false);
    const state = (worker as any).loadQueuedInputState(agentId);
    expect(state.consumedSourceRefs).not.toContain('cmd-cp-1');
    expect(state.cancelledCommandIds).toContain('cmd-cp-1');

    // 重启后取消事实仍在：重投被拒，且不重新入队
    const second = createWorker('cancel-persist-agent', dir);
    const resubmit = second.worker.submitUserTurn('cancel-persist-agent', {
      text: 'cancel me', sourceRef: 'cmd-cp-1', sessionId: 'ws-cp', commandIdentity: identity,
    });
    expect(resubmit).toMatchObject({ success: false, code: 'command_cancelled' });
    expect(second.session.queuedInputs).toHaveLength(0);
    // 重启后迟到 ack 同样不得复活
    expect(ackViaMethod(second.worker, 'cancel-persist-agent', claimed.inputLease!)).toBe(false);

    // 截点后的新 durable 命令不属于本次取消：正常接收、保留、可领取
    second.session.threadId = 'thread-cp';
    second.session.headGeneration = 2;
    second.session.workSessionId = 'ws-cp';
    second.session.runtimeInstanceId = 'rt-cp';
    second.session.callActive = true;
    const freshIdentity = { commandId: 'cmd-cp-2', threadId: 'thread-cp', headGeneration: 2 };
    expect(second.worker.submitUserTurn('cancel-persist-agent', {
      text: 'after checkpoint', sourceRef: 'cmd-cp-2', sessionId: 'ws-cp', commandIdentity: freshIdentity,
    })).toMatchObject({ success: true, delivery: 'queued' });
    expect(second.session.queuedInputs).toHaveLength(1);
    expect(claimViaMethod(second.worker, 'cancel-persist-agent')).toMatchObject({ sourceRef: 'cmd-cp-2' });
  });

  it('keeps the queue intact and fails the interrupt (503) when the cancel checkpoint store write fails', async () => {
    // §6.2：取消必须由持久事实线性化。store 写失败时不得静默清队列、
    // 不得向 runtime 发送无回执能力的取消帧——显式 503，调用方可重试。
    const dir = join(root, 'cancel-storefail');
    const { worker, session, agentId } = createWorker('cancel-storefail-agent', dir);
    session.threadId = 'thread-csf';
    session.headGeneration = 1;
    session.workSessionId = 'ws-csf';
    session.runtimeInstanceId = 'rt-csf';
    session.callActive = true;
    expect(worker.submitUserTurn(agentId, {
      text: 'pending cancel', sourceRef: 'cmd-csf-1', sessionId: 'ws-csf',
      commandIdentity: { commandId: 'cmd-csf-1', threadId: 'thread-csf', headGeneration: 1 },
    })).toMatchObject({ success: true, delivery: 'queued' });

    const writes: string[] = [];
    (worker as any).udsClients.set('client-1', { write(message: string) { writes.push(message); } });
    const blocker = join(root, 'blocker-file-3');
    await wf(blocker, 'x', 'utf8');
    (worker as any).queuedInputStoreDir = blocker;

    let status = 0;
    let body = '';
    const res: any = { writeHead(code: number) { status = code; }, end(payload: string) { body = payload; } };
    (worker as any).handleInterrupt({ resume() {} } as any, res, agentId);
    expect(status).toBe(503);
    expect(JSON.parse(body).code).toBe('persistent_store_unavailable');
    expect(session.queuedInputs).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });

  it('claims durably and removes a WorkThread input only for the exact runtime/head receipt', () => {
    const dir = join(root, 'claim-ack');
    const { worker, session, agentId } = createWorker('claim-ack-agent', dir);
    session.threadId = 'thread-claim';
    session.headGeneration = 7;
    session.workSessionId = 'work-session-2';
    session.runtimeInstanceId = 'runtime-a';
    session.callActive = true;
    const submitted = worker.submitUserTurn(agentId, {
      text: 'execute once', sourceRef: 'cmd-claim', sessionId: 'work-session-2',
      commandIdentity: { commandId: 'cmd-claim', threadId: 'thread-claim', headGeneration: 7 },
    });
    expect(submitted).toMatchObject({ success: true, delivery: 'queued' });

    const claimed = claimViaMethod(worker, agentId)!;
    expect(claimed.inputLease).toMatchObject({
      commandId: 'cmd-claim', threadId: 'thread-claim', headGeneration: 7,
      sessionId: 'work-session-2', runtimeInstanceId: 'runtime-a',
    });
    expect(session.queuedInputs).toHaveLength(1);
    const restored = createWorker('claim-ack-agent', dir);
    expect(restored.session.queuedInputs[0]?.inputLease?.leaseId).toBe(claimed.inputLease?.leaseId);

    const wrongRuntime = { ...claimed.inputLease!, runtimeInstanceId: 'stale-runtime' };
    expect(ackViaMethod(worker, agentId, wrongRuntime)).toBe(false);
    expect(session.queuedInputs).toHaveLength(1);
    expect(ackViaMethod(worker, agentId, claimed.inputLease)).toBe(true);
    expect(session.queuedInputs).toHaveLength(0);

    // Viewer 重启后，ack 的持久结果必须仍然是队列空，而非仅内存删除。
    const afterAckRestart = createWorker('claim-ack-agent', dir);
    expect(afterAckRestart.session.queuedInputs).toHaveLength(0);
  });

  it('treats a repeated ack after success as idempotent and a post-ack resubmit as consumed (stage 5 review P2-6)', () => {
    // ack 响应丢失后 runtime 重试 ack：条目已移除，不得按身份不符拒绝
    // （否则投递方按不可重试失败放弃 → 指令状态与真实执行不一致）。
    // 已 ack 命令的重投（投递响应丢失 + 已 claim/ack 窗口）：两层去重
    // 命中 consumed，不重新入队二次执行。
    const dir = join(root, 'ack-idempotent');
    const { worker, session, agentId } = createWorker('ack-idem-agent', dir);
    session.threadId = 'thread-idem';
    session.headGeneration = 3;
    session.workSessionId = 'ws-idem';
    session.runtimeInstanceId = 'runtime-idem';
    session.callActive = true;
    const identity = { commandId: 'cmd-idem-1', threadId: 'thread-idem', headGeneration: 3 };
    expect(worker.submitUserTurn(agentId, {
      text: 'once only', sourceRef: 'cmd-idem-1', sessionId: 'ws-idem', commandIdentity: identity,
    })).toMatchObject({ success: true, delivery: 'queued' });

    const claimed = claimViaMethod(worker, agentId)!;
    expect(claimed).toBeTruthy();
    expect(ackViaMethod(worker, agentId, claimed.inputLease!)).toBe(true);
    // 重复 ack（响应丢失重试）：幂等成功，而不是 409
    expect(ackViaMethod(worker, agentId, claimed.inputLease!)).toBe(true);

    // 已消费重投：consumed，不重新入队
    const resubmit = worker.submitUserTurn(agentId, {
      text: 'once only', sourceRef: 'cmd-idem-1', sessionId: 'ws-idem', commandIdentity: identity,
    });
    expect(resubmit).toMatchObject({ success: true, delivery: 'consumed', duplicate: true });
    expect(session.queuedInputs).toHaveLength(0);

    // 重启后幂等口径仍在：新实例上再次重复 ack 仍幂等（持久消费集）
    const restarted = createWorker('ack-idem-agent', dir);
    restarted.session.threadId = 'thread-idem';
    restarted.session.headGeneration = 3;
    restarted.session.workSessionId = 'ws-idem';
    restarted.session.runtimeInstanceId = 'runtime-idem';
    expect(ackViaMethod(restarted.worker, 'ack-idem-agent', claimed.inputLease!)).toBe(true);
    expect(restarted.session.queuedInputs).toHaveLength(0);
  });

  it('never hands a fenced WorkThread command from the queue head to a plain input request (stage 5 review P1-3)', () => {
    // 直答活动租约会绕过 claim/ack 协议（无持久 lease、无身份校验、无
    // 回执盖戳）。队首是带 commandIdentity 的命令时必须留在持久队列，
    // 由 runtime 的 claim 路径接管。对照组：普通排队消息照常转交——
    // 证明观察点（队列位移 + 消费引用）真实可见。
    const dir = join(root, 'handover-fenced');
    const { worker, session, agentId } = createWorker('fenced-agent', dir);

    // 对照组：普通文本项 → 转交（队列位移可观察）
    session.callActive = true;
    worker.submitUserTurn(agentId, { text: 'plain handover', source: 'thread', sourceRef: 'cmd-plain-h' });
    expect(session.queuedInputs).toHaveLength(1);
    (worker as any).handleRequestInput({ agentId, requestId: 'req-plain', mode: 'text', prompt: 'p' });
    expect(session.queuedInputs).toHaveLength(0);
    expect((worker as any).loadQueuedInputState(agentId).consumedSourceRefs).toContain('cmd-plain-h');

    // 目标行为：带 commandIdentity 的队首项 → 不转交、不记消费
    session.threadId = 'thread-fenced';
    session.headGeneration = 5;
    session.workSessionId = 'ws-fenced';
    session.runtimeInstanceId = 'runtime-f';
    worker.submitUserTurn(agentId, {
      text: 'fenced stays', sourceRef: 'cmd-fenced-1', sessionId: 'ws-fenced',
      commandIdentity: { commandId: 'cmd-fenced-1', threadId: 'thread-fenced', headGeneration: 5 },
    });
    expect(session.queuedInputs).toHaveLength(1);
    (worker as any).handleRequestInput({ agentId, requestId: 'req-fenced', mode: 'text', prompt: 'p' });
    expect(session.queuedInputs).toHaveLength(1);
    expect(session.queuedInputs[0]).toMatchObject({ sourceRef: 'cmd-fenced-1' });
    expect((worker as any).loadQueuedInputState(agentId).consumedSourceRefs).not.toContain('cmd-fenced-1');

    // claim 路径接管：该命令仍可被 runtime 按协议领取
    const claimed = claimViaMethod(worker, agentId);
    expect(claimed).toMatchObject({ sourceRef: 'cmd-fenced-1' });
    expect(claimed!.inputLease).toMatchObject({ commandId: 'cmd-fenced-1', threadId: 'thread-fenced', headGeneration: 5 });
  });

  it('keeps legacy in-memory behavior when no storeDir is configured (compat surface)', () => {
    const { worker, session, agentId } = createWorker('legacy-agent');
    session.callActive = true;
    worker.submitUserTurn(agentId, { text: 'a', source: 'thread', sourceRef: 'cmd-legacy-1' });
    // 无持久化去重：同 sourceRef 重复提交照旧入队（旧行为，不误伤直发宿主）
    worker.submitUserTurn(agentId, { text: 'a', source: 'thread', sourceRef: 'cmd-legacy-1' });
    expect(session.queuedInputs).toHaveLength(2);
  });

  it('does not deduplicate inputs without sourceRef (frontend direct messages unchanged)', () => {
    const { worker, session, agentId } = createWorker('nosref-agent', join(root, 'nosref'));
    session.callActive = true;
    worker.submitUserTurn(agentId, { text: 'hello' });
    worker.submitUserTurn(agentId, { text: 'hello' });
    expect(session.queuedInputs).toHaveLength(2);
  });

  it('recovers to an empty queue when the persisted file is corrupt (quarantined, not fatal)', async () => {
    const dir = join(root, 'corrupt');
    const first = createWorker('corrupt-agent', dir);
    first.session.callActive = true;
    first.worker.submitUserTurn('corrupt-agent', { text: 'x', source: 'thread', sourceRef: 'cmd-c-1' });

    // 破坏持久文件 → 新 worker 按空队列启动（隔离取证，不炸）。
    // 已知取舍：损坏恢复后去重窗口重置，重投会重新入队——无条件幂等
    // 由 Inbox 状态机兜底（delivered 命令不重投）。
    const files = await readdir(join(dir, 'queued-inputs'));
    const target = join(dir, 'queued-inputs', files[0]);
    await writeFile(target, '{ not json', 'utf8');
    const second = createWorker('corrupt-agent', dir);
    expect(Array.isArray(second.session.queuedInputs)).toBe(true);
    expect(second.session.queuedInputs).toHaveLength(0);
  });

  // ── ADR-0047 claim 期时序补充：换头采纳 / 重启换租 / 混合 FIFO ──────────
  //
  // 既有用例覆盖 submit 期 fencing 与 ack 幂等；以下三例锁定 claim 期的
  // 身份链语义——队列项的 fencing 不止于提交面，领取面同样拒绝陈旧身份。

  it('refuses to claim a stale-generation durable item after the head re-registered at a newer generation (claim-level fencing)', () => {
    // 换头采纳缺口在 viewer 侧的收敛：旧代（gen3）队列项对已采纳到新代
    // （gen4）的会话永远不可领取，但也绝不静默丢弃——处置权在 Inbox 的
    // unresolved 事实，Viewer 只持有。恢复路径：Inbox reissue 以新
    // commandId + 当前代身份入队 → 可领取、可结清。
    const dir = join(root, 'claim-fencing');
    const { worker, session, agentId } = createWorker('claim-fence-agent', dir);
    session.threadId = 'thread-cf';
    session.headGeneration = 3;
    session.workSessionId = 'ws-cf';
    session.runtimeInstanceId = 'rt-cf-1';
    session.callActive = true;
    expect(worker.submitUserTurn(agentId, {
      text: 'gen3 command', sourceRef: 'cmd-cf-1', sessionId: 'ws-cf',
      commandIdentity: { commandId: 'cmd-cf-1', threadId: 'thread-cf', headGeneration: 3 },
    })).toMatchObject({ success: true, delivery: 'queued' });

    // 换头采纳：同会话重注册到 gen4（新 head runtime）
    session.headGeneration = 4;
    session.runtimeInstanceId = 'rt-cf-2';
    expect(claimViaMethod(worker, agentId)).toBeNull();
    expect(session.queuedInputs).toHaveLength(1);

    // 重启 + 新 runtime 采纳后依旧不可领取（持久事实，不是内存巧合）
    const second = createWorker('claim-fence-agent', dir);
    second.session.threadId = 'thread-cf';
    second.session.headGeneration = 4;
    second.session.workSessionId = 'ws-cf';
    second.session.runtimeInstanceId = 'rt-cf-2';
    second.session.callActive = true;
    expect(claimViaMethod(second.worker, 'claim-fence-agent')).toBeNull();
    expect(second.session.queuedInputs).toHaveLength(1);

    // 协议恢复路径：Inbox reissue 投给新 head runtime 的独立会话（生产
    // 拓扑：每代 head runtime 是独立 viewer 会话/队列文件，陈旧项不会与新
    // 项同队）。新 commandId + 当前代身份 → 可领取、可结清。
    const next = createWorker('claim-fence-agent-next', dir);
    next.session.threadId = 'thread-cf';
    next.session.headGeneration = 4;
    next.session.workSessionId = 'ws-cf';
    next.session.runtimeInstanceId = 'rt-cf-next';
    next.session.callActive = true;
    expect(next.worker.submitUserTurn('claim-fence-agent-next', {
      text: 'gen3 command (reissued)', sourceRef: 'cmd-cf-2', sessionId: 'ws-cf',
      commandIdentity: { commandId: 'cmd-cf-2', threadId: 'thread-cf', headGeneration: 4 },
    })).toMatchObject({ success: true, delivery: 'queued' });
    const claimed = claimViaMethod(next.worker, 'claim-fence-agent-next');
    expect(claimed).toMatchObject({ sourceRef: 'cmd-cf-2' });
    expect(claimed!.inputLease).toMatchObject({ headGeneration: 4, runtimeInstanceId: 'rt-cf-next' });
    expect(ackViaMethod(next.worker, 'claim-fence-agent-next', claimed!.inputLease!)).toBe(true);
    expect(next.session.queuedInputs).toHaveLength(0);
    // 旧 gen3 项在原会话队列保留：它是 Inbox unresolved 的事实物证，
    // 不归 Viewer 处置
    expect(second.session.queuedInputs).toHaveLength(1);
    expect(second.session.queuedInputs[0]).toMatchObject({ sourceRef: 'cmd-cf-1' });
  });

  it('rotates the durable lease when the runtime re-registers after a restart and rejects the old lease ack', () => {
    // claim 后 runtime 崩溃重启（新 runtimeInstanceId，同代 head）：重启
    // 恢复的队列项可被重新领取，但租约必须轮换——旧 runtime 迟到的 ack
    // 不得移除新 runtime 名下的项（否则同指令存在二次执行窗口）。
    const dir = join(root, 'lease-rotate');
    const first = createWorker('lease-rotate-agent', dir);
    first.session.threadId = 'thread-lr';
    first.session.headGeneration = 2;
    first.session.workSessionId = 'ws-lr';
    first.session.runtimeInstanceId = 'rt-lr-a';
    first.session.callActive = true;
    expect(first.worker.submitUserTurn('lease-rotate-agent', {
      text: 'restart lease', sourceRef: 'cmd-lr-1', sessionId: 'ws-lr',
      commandIdentity: { commandId: 'cmd-lr-1', threadId: 'thread-lr', headGeneration: 2 },
    })).toMatchObject({ success: true, delivery: 'queued' });

    const lease1 = claimViaMethod(first.worker, 'lease-rotate-agent')!.inputLease!;
    expect(lease1).toMatchObject({ runtimeInstanceId: 'rt-lr-a', headGeneration: 2 });

    // worker 重启 + runtime 重启（新实例 id，同代）：重新领取 → 新租约
    const second = createWorker('lease-rotate-agent', dir);
    second.session.threadId = 'thread-lr';
    second.session.headGeneration = 2;
    second.session.workSessionId = 'ws-lr';
    second.session.runtimeInstanceId = 'rt-lr-b';
    second.session.callActive = true;
    const reClaimed = claimViaMethod(second.worker, 'lease-rotate-agent');
    expect(reClaimed).toMatchObject({ sourceRef: 'cmd-lr-1' });
    const lease2 = reClaimed!.inputLease!;
    expect(lease2.leaseId).not.toBe(lease1.leaseId);
    expect(lease2).toMatchObject({ runtimeInstanceId: 'rt-lr-b', headGeneration: 2 });

    // 旧租约 ack（旧 runtime 崩溃前的迟到回执）：拒绝，项不被移除
    expect(ackViaMethod(second.worker, 'lease-rotate-agent', lease1)).toBe(false);
    expect(second.session.queuedInputs).toHaveLength(1);
    // 新租约 ack：结清；重启后持久结果仍是空队列
    expect(ackViaMethod(second.worker, 'lease-rotate-agent', lease2)).toBe(true);
    expect(second.session.queuedInputs).toHaveLength(0);
    const third = createWorker('lease-rotate-agent', dir);
    expect(third.session.queuedInputs).toHaveLength(0);
  });

  it('keeps FIFO discipline across mixed legacy and durable items: legacy via dequeue, durable only via claim', () => {
    // React drain / CallArbiter 安全网（legacy dequeue）与 claim/ack 协议
    // 共享一条队列：durable 项是队首时 legacy 路径必须让路（返回 null、
    // 不移除），claim 领取未 ack 期间同样不让路；结清后 FIFO 恢复。
    const dir = join(root, 'mixed-fifo');
    const { worker, session, agentId } = createWorker('mixed-fifo-agent', dir);
    session.threadId = 'thread-mf';
    session.headGeneration = 1;
    session.workSessionId = 'ws-mf';
    session.runtimeInstanceId = 'rt-mf';
    session.callActive = true;
    worker.submitUserTurn(agentId, { text: 'plain A', source: 'thread', sourceRef: 'cmd-mf-a' });
    worker.submitUserTurn(agentId, {
      text: 'durable D', sourceRef: 'cmd-mf-d', sessionId: 'ws-mf',
      commandIdentity: { commandId: 'cmd-mf-d', threadId: 'thread-mf', headGeneration: 1 },
    });
    worker.submitUserTurn(agentId, { text: 'plain B', source: 'thread', sourceRef: 'cmd-mf-b' });
    expect(session.queuedInputs).toHaveLength(3);

    // 队首普通项：legacy dequeue 照常消费（A）
    const first = dequeueViaHandler(worker, agentId);
    expect(first.status).toBe(200);
    expect(first.body.input?.sourceRef).toBe('cmd-mf-a');
    expect(session.queuedInputs).toHaveLength(2);

    // 队首 durable 项：legacy drain 不接管（协议独占），已 claim 未 ack
    // 期间同样不移交
    let guarded = dequeueViaHandler(worker, agentId);
    expect(guarded.status).toBe(200);
    expect(guarded.body.input).toBeNull();
    expect(guarded.body.remaining).toBe(2);
    const claimed = claimViaMethod(worker, agentId);
    expect(claimed).toMatchObject({ sourceRef: 'cmd-mf-d' });
    guarded = dequeueViaHandler(worker, agentId);
    expect(guarded.body.input).toBeNull();
    expect(session.queuedInputs).toHaveLength(2);
    expect(ackViaMethod(worker, agentId, claimed!.inputLease!)).toBe(true);

    // durable 结清后，后续普通项恢复 FIFO
    const last = dequeueViaHandler(worker, agentId);
    expect(last.body.input?.sourceRef).toBe('cmd-mf-b');
    expect(session.queuedInputs).toHaveLength(0);
  });
});
