/**
 * ADR-0031 步骤一：派发 → 执行结果 的隔离链路测试。
 *
 * 链路：command 回执（appendCommand）→ bridge（sourceRef=commandId）→
 * 模拟 runtime 消费并上报 turn 事件（宿主上报契约：事件携带 sourceRef）→
 * board.recordRuntimeEvent → getExecutionEvents 查询。
 *
 * 全部确定性：bridge submitTurn stub 捕获投递、fake runtime 按脚本上报、
 * 隔离临时目录，无真实服务、无 sleep/poll。观察器判定规则（本契约的实现
 * 语义）在每个场景内联断言：
 *   - 终态匹配按 sourceRef === 派发回执的 commandId；
 *   - suspended=true 的 turn.completed 不是完成，其 pendingWakeups（source+id）
 *     构成等待集；
 *   - 唤醒轮经线程域换得新 commandId，originSourceRef 保留通知事件身份，
 *     metadata 携带工作引用——观察器可据此关联等待关系；
 *   - 旧轮终态不匹配排队新指令；幂等重复不重投不重复入板；
 *   - 接力后指令导向新 head，turn 事件跨 session 仍按 sourceRef 关联。
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkThreadStore } from '../../src/core/workthread/store.js';
import { WorkThread } from '../../src/core/workthread/core.js';
import { WorkThreadBoard } from '../../src/core/workthread/board.js';
import { WorkThreadRuntimeBridge } from '../../src/core/workthread/bridge.js';
import type { WorkThreadBridgeSubmitTurnParams } from '../../src/core/workthread/bridge.js';

const AGENT_ID = 'coder-a';

interface Env {
  root: string;
  core: WorkThread;
  board: WorkThreadBoard;
  submitted: WorkThreadBridgeSubmitTurnParams[];
  setRuntimeOnline(online: boolean): void;
}

async function makeEnv(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'agentdev-wt-chain-'));
  const submitted: WorkThreadBridgeSubmitTurnParams[] = [];
  let online = true;
  const store = new WorkThreadStore({ rootDir: join(root, 'threads') });
  const bridge = new WorkThreadRuntimeBridge({
    enabled: true,
    resolveRuntimeViewerId: () => (online ? 'viewer-x' : null),
    submitTurn: async (params) => {
      submitted.push(params);
    },
  });
  const core = new WorkThread({ store, bridge });
  const board = new WorkThreadBoard({ core, rootDir: join(root, 'boards') });
  return {
    root,
    core,
    board,
    submitted,
    setRuntimeOnline(v: boolean) {
      online = v;
    },
  };
}

/** fake runtime：按宿主上报契约把一个 turn 的 started/终态事件写入看板。 */
async function fakeTurn(
  env: Env,
  sessionId: string,
  sourceRef: string,
  opts: {
    suspended?: boolean;
    wakeups?: Array<{ source: string; id: string; summary: string }>;
    failed?: boolean;
    failReason?: string;
    consumed?: string[];
    turn?: number;
  } = {},
): Promise<void> {
  const turn = opts.turn ?? 0;
  await env.board.recordRuntimeEvent({
    agentId: AGENT_ID,
    sessionId,
    event: { type: 'turn.started', turn, source: 'thread', sourceRef },
  });
  if (opts.failed) {
    await env.board.recordRuntimeEvent({
      agentId: AGENT_ID,
      sessionId,
      event: {
        type: 'turn.failed',
        turn,
        source: 'thread',
        sourceRef,
        ...(opts.consumed && opts.consumed.length > 0 ? { consumedSourceRefs: opts.consumed } : {}),
        error: { message: 'execution ended without completing', reason: opts.failReason ?? 'limit_reached', category: 'runtime' },
      },
    });
    return;
  }
  await env.board.recordRuntimeEvent({
    agentId: AGENT_ID,
    sessionId,
    event: {
      type: 'turn.completed',
      turn,
      source: 'thread',
      sourceRef,
      ...(opts.suspended
        ? { suspended: true, ...(opts.wakeups ? { pendingWakeups: opts.wakeups } : {}) }
        : {}),
    },
  });
}

/** 观察器判定辅助：终态事件里 sourceRef===commandId 的条目是否存在。 */
async function findTerminal(env: Env, threadId: string, commandId: string): Promise<Record<string, unknown> | null> {
  const { events } = await env.board.getExecutionEvents(threadId);
  return (
    events.find(
      (e) =>
        e.sourceRef === commandId &&
        (e.type === 'turn.completed' || e.type === 'turn.cancelled' || e.type === 'turn.failed'),
    ) ?? null
  );
}

describe('WorkThread association chain (ADR-0031 step 1)', () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  async function freshEnv(): Promise<Env> {
    const env = await makeEnv();
    roots.push(env.root);
    return env;
  }

  it('queued new command is not matched by the previous round terminal (stale-turn misattribution blocked)', async () => {
    const env = await freshEnv();
    const wt = await env.core.start({ sessionRef: { agentId: AGENT_ID, sessionId: 's1' } });

    // 派发 cmd1 并被 runtime 消费（执行中，尚未落定）
    const r1 = await env.core.appendCommand({ threadId: wt.threadId, text: 'task one', idempotencyKey: 'k1' });
    expect(r1.duplicate).toBe(false);
    await env.core.deliverPendingCommands(wt.threadId);
    expect(env.submitted[0]?.sourceRef).toBe(r1.command.commandId);
    await fakeTurn(env, 's1', r1.command.commandId, { suspended: true, wakeups: [{ source: 'shell', id: 'bg-1', summary: 'npm test' }] });

    // busy 期间排队追加 cmd2
    const r2 = await env.core.appendCommand({ threadId: wt.threadId, text: 'task two', idempotencyKey: 'k2' });
    await env.core.deliverPendingCommands(wt.threadId);
    expect(env.submitted[1]?.sourceRef).toBe(r2.command.commandId);

    // 旧轮（cmd1）的终态事件：suspended 不是 cmd1 的完成，更不匹配 cmd2
    const cmd1Terminal = await findTerminal(env, wt.threadId, r1.command.commandId);
    expect(cmd1Terminal).not.toBeNull();
    expect((cmd1Terminal as { suspended?: boolean }).suspended).toBe(true);
    // cmd2 无任何终态事件：观察器不得把 cmd1 的终态当作 cmd2 的完成
    expect(await findTerminal(env, wt.threadId, r2.command.commandId)).toBeNull();

    // cmd2 自己的回合落定后，其终态事件才出现且身份独立
    await fakeTurn(env, 's1', r2.command.commandId, { turn: 1 });
    const cmd2Terminal = await findTerminal(env, wt.threadId, r2.command.commandId);
    expect(cmd2Terminal).not.toBeNull();
    expect((cmd2Terminal as { suspended?: boolean }).suspended).toBeUndefined();
  });

  it('fast complete: submit receipt → delivery → turn events → done (event reason present on failure)', async () => {
    const env = await freshEnv();
    const wt = await env.core.start({ sessionRef: { agentId: AGENT_ID, sessionId: 's1' } });

    const r = await env.core.appendCommand({ threadId: wt.threadId, text: 'quick task', idempotencyKey: 'kf' });
    // 提交回执即携带 commandId（观察器关联锚点的起点）
    expect(r.command.commandId).toMatch(/^cmd-/);
    const delivery = await env.core.deliverPendingCommands(wt.threadId);
    expect(delivery.delivered).toBe(1);

    // runtime 失败收尾（如 step 预算耗尽）：终态事件带 reason，不是完成
    await fakeTurn(env, 's1', r.command.commandId, { failed: true, failReason: 'limit_reached', consumed: ['cmd-queued-x'] });
    const terminal = await findTerminal(env, wt.threadId, r.command.commandId);
    expect(terminal).not.toBeNull();
    expect((terminal as { type: string }).type).toBe('turn.failed');
    expect(((terminal as { error?: { reason?: string } }).error)?.reason).toBe('limit_reached');
    expect((terminal as { consumedSourceRefs?: string[] }).consumedSourceRefs).toEqual(['cmd-queued-x']);
  });

  it('idempotent duplicate: no re-delivery, no duplicate board events', async () => {
    const env = await freshEnv();
    const wt = await env.core.start({ sessionRef: { agentId: AGENT_ID, sessionId: 's1' } });

    const first = await env.core.appendCommand({ threadId: wt.threadId, text: 'once', idempotencyKey: 'k-dup' });
    const second = await env.core.appendCommand({ threadId: wt.threadId, text: 'once', idempotencyKey: 'k-dup' });
    expect(second.duplicate).toBe(true);
    expect(second.command.commandId).toBe(first.command.commandId);

    await env.core.deliverPendingCommands(wt.threadId);
    const forCommand = env.submitted.filter((p) => p.sourceRef === first.command.commandId);
    expect(forCommand).toHaveLength(1);

    // runtime 重复上报同 eventId（宿主重试/重放）：board 按 eventId 去重
    const event = { type: 'turn.completed', turn: 0, source: 'thread', sourceRef: first.command.commandId, eventId: `${'runtime-x'}:turn.completed:0` };
    await env.board.recordRuntimeEvent({ agentId: AGENT_ID, sessionId: 's1', event });
    await env.board.recordRuntimeEvent({ agentId: AGENT_ID, sessionId: 's1', event });
    const { events } = await env.board.getExecutionEvents(wt.threadId);
    expect(events.filter((e) => e.eventId === event.eventId)).toHaveLength(1);
  });

  it('suspended then wakeup: originSourceRef keeps the wait relation to the original command', async () => {
    const env = await freshEnv();
    const wt = await env.core.start({ sessionRef: { agentId: AGENT_ID, sessionId: 's1' } });

    const r1 = await env.core.appendCommand({ threadId: wt.threadId, text: 'long task', idempotencyKey: 'k-sus' });
    await env.core.deliverPendingCommands(wt.threadId);
    // 执行轮挂起：等 shell 后台任务 bg-9
    await fakeTurn(env, 's1', r1.command.commandId, {
      suspended: true,
      wakeups: [{ source: 'shell', id: 'bg-9', summary: 'npm test' }],
    });
    // suspended 的 completed 不是完成
    const suspendedTerminal = await findTerminal(env, wt.threadId, r1.command.commandId);
    expect((suspendedTerminal as { suspended?: boolean }).suspended).toBe(true);

    // 唤醒通报进入线程域：事件身份与工作引用分别保留
    const wake = await env.core.appendCommand({
      threadId: wt.threadId,
      kind: 'reminder',
      source: 'shell',
      text: '[后台任务 bg-9 已完成] npm test 退出码 0',
      idempotencyKey: 'gw-shell-evt-completed-9',
      originSourceRef: 'shell-evt-completed-9',
      metadata: { shell: { taskId: 'bg-9', taskIds: ['bg-9'] } },
    });
    expect(wake.command.originSourceRef).toBe('shell-evt-completed-9');
    expect(wake.command.metadata).toEqual({ shell: { taskId: 'bg-9', taskIds: ['bg-9'] } });
    expect(wake.command.kind).toBe('reminder');
    await env.core.deliverPendingCommands(wt.threadId);
    const wakeDelivery = env.submitted.find((p) => p.sourceRef === wake.command.commandId);
    expect(wakeDelivery).toBeDefined();

    // 唤醒轮落定（非 suspended）：原指令链的执行至此完成；
    // 完成事件的 sourceRef 是唤醒轮 commandId，不是原指令也不是 suspended 事件
    await fakeTurn(env, 's1', wake.command.commandId, { turn: 1 });
    const wakeTerminal = await findTerminal(env, wt.threadId, wake.command.commandId);
    expect(wakeTerminal).not.toBeNull();
    expect((wakeTerminal as { suspended?: boolean }).suspended).toBeUndefined();
    expect(wake.command.commandId).not.toBe(r1.command.commandId);

    // 重复唤醒通报（同幂等键）：不重投、不产生第二条指令
    const dup = await env.core.appendCommand({
      threadId: wt.threadId,
      kind: 'reminder',
      source: 'shell',
      text: '[后台任务 bg-9 已完成] npm test 退出码 0',
      idempotencyKey: 'gw-shell-evt-completed-9',
      originSourceRef: 'shell-evt-completed-9',
      metadata: { shell: { taskId: 'bg-9', taskIds: ['bg-9'] } },
    });
    expect(dup.duplicate).toBe(true);
    expect(dup.command.commandId).toBe(wake.command.commandId);
  });

  it('M8D-PENDING-REF succession: pending command follows the new head and keeps its sourceRef across sessions', async () => {
    const env = await freshEnv();
    const wt = await env.core.start({ sessionRef: { agentId: AGENT_ID, sessionId: 's1' } });

    // runtime 不在：指令入箱滞留（M8D-RUNTIME-OUT 语义）
    env.setRuntimeOnline(false);
    const r = await env.core.appendCommand({ threadId: wt.threadId, text: 'survives rotation', idempotencyKey: 'k-rot' });
    const blocked = await env.core.deliverPendingCommands(wt.threadId);
    expect(blocked.delivered).toBe(0);

    // 接力：head s1 → s2，指令 pending 穿越（revision 取 append 后的最新值）
    const fresh = await env.core.getThread(wt.threadId);
    await env.core.advanceHead({
      threadId: wt.threadId,
      toSessionId: 's2',
      fromSessionId: 's1',
      expectedRevision: fresh?.revision,
      endKind: 'context_rotation',
    });

    // 新 head runtime 就绪后投递：sourceRef 保持原 commandId
    env.setRuntimeOnline(true);
    const delivery = await env.core.deliverPendingCommands(wt.threadId);
    expect(delivery.delivered).toBe(1);
    expect(env.submitted[0]?.sourceRef).toBe(r.command.commandId);

    // 新 head 上的执行事件：sessionId 已换代（turn 号从 0 重算），
    // 观察器按 sourceRef 关联，不受 turn 号重置影响
    await fakeTurn(env, 's2', r.command.commandId, { turn: 0 });
    const terminal = await findTerminal(env, wt.threadId, r.command.commandId);
    expect(terminal).not.toBeNull();
    const { events } = await env.board.getExecutionEvents(wt.threadId);
    const started = events.find((e) => e.type === 'turn.started' && e.sourceRef === r.command.commandId);
    expect(started).toBeDefined();
  });
});
