/**
 * WorkThreadBoard 测试（ticket 007）— 可选平行执行看板。
 *
 * 自 Claw `test/thread-control.test.js` 的执行调度部分随迁：
 * - recordRuntimeEvent 把 codex turn.* / item.* 事件翻译为看板状态
 * - idle/running/waiting_input/failed 状态机
 * - executionEvents 持久化 / cursor 切片 / eventId 去重
 * - 绝对游标（ticket 017）：跨裁剪点增量读不丢不重；after < baseOffset 返回
 *   完整当前窗口；重启后 baseOffset 恢复、cursor 不回退
 * - resume（failed/waiting_input → running，拒绝其他）
 * - mode
 * - closed 语义：closed 线程拒绝迟到事件；closeBoard 置看板终态
 *
 * 纪律：看板永不反写锚点状态——本套件验证 recordRuntimeEvent / resume /
 * closeBoard 只改看板域，锚点记录（head/commands/pendingSuccession）不受影响。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkThreadStore } from '../../src/core/workthread/store.js';
import { WorkThread } from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge } from '../../src/core/workthread/bridge.js';
import { WorkThreadBoard } from '../../src/core/workthread/board.js';

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentdev-board-'));
}

/** 看板套件：锚点 + 看板，共用同一 rootDir 下两个独立持久化域。 */
function makeBoardFixtures(root: string) {
  const store = new WorkThreadStore({ rootDir: root });
  const core = new WorkThread({ store, bridge: new WorkThreadRuntimeBridge() });
  const board = new WorkThreadBoard({ core, rootDir: root });
  return { core, board };
}

describe('WorkThreadBoard', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('recordRuntimeEvent drives idle/running/failed from the session turn stream', async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'event-agent', sessionId: 'event-session' } });

    const started = await board.recordRuntimeEvent({
      agentId: 'event-agent', sessionId: 'event-session', runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.started', turn: 1 },
    });
    expect(started.applied).toBe(true);
    expect(started.state?.status).toBe('running');

    const completed = await board.recordRuntimeEvent({
      agentId: 'event-agent', sessionId: 'event-session', runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.completed', turn: 1, usage: { inputTokens: 2, outputTokens: 3 } },
    });
    expect(completed.state?.status).toBe('idle');
    expect(completed.state?.lastLifecycleEvent?.type).toBe('turn.completed');

    const failed = await board.recordRuntimeEvent({
      agentId: 'event-agent', sessionId: 'event-session', runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.failed', turn: 2, error: { message: 'API unavailable', retryable: true } },
    });
    expect(failed.state?.status).toBe('failed');
    expect(failed.state?.lastLifecycleEvent?.error).toMatchObject({ message: 'API unavailable' });
    expect((await board.getState(wt.threadId))?.status).toBe('failed');
  });

  it('turn.cancelled is a lifecycle signal: event recorded, status unchanged', async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'cancel-agent', sessionId: 'cancel-session' } });
    await board.recordRuntimeEvent({
      agentId: 'cancel-agent', sessionId: 'cancel-session', runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.started', turn: 1 },
    });

    // guard 轮换打断：cancelled 不得把看板打成 failed
    const cancelled = await board.recordRuntimeEvent({
      agentId: 'cancel-agent', sessionId: 'cancel-session', runtimeInstanceId: 'runtime-1',
      event: { type: 'turn.cancelled', turn: 1, error: { message: 'Session blocked by the context guard', reason: 'cancelled' } },
    });
    expect(cancelled.applied).toBe(true);
    expect(cancelled.state?.status).toBe('running');

    const stored = await board.getExecutionEvents(wt.threadId);
    expect(stored.events.some((e) => e.type === 'turn.cancelled')).toBe(true);

    // 轮换接续：head 推进（锚点层）后，新 turn 自然完成，看板回 idle
    await core.advanceHead({ threadId: wt.threadId, toSessionId: 'cancel-session-2', fromSessionId: 'cancel-session', endKind: 'context_rotation' });
    await board.recordRuntimeEvent({
      agentId: 'cancel-agent', sessionId: 'cancel-session-2', runtimeInstanceId: 'runtime-2',
      event: { type: 'turn.started', turn: 2 },
    });
    const resumed = await board.recordRuntimeEvent({
      agentId: 'cancel-agent', sessionId: 'cancel-session-2', runtimeInstanceId: 'runtime-2',
      event: { type: 'turn.completed', turn: 2 },
    });
    expect(resumed.state?.status).toBe('idle');
  });

  it('recordRuntimeEvent ignores unsupported events and sessions outside a thread', async () => {
    const { core, board } = makeBoardFixtures(root);
    await core.start({ sessionRef: { agentId: 'event-agent-2', sessionId: 'event-session-2' } });

    expect(
      await board.recordRuntimeEvent({ agentId: 'other-agent', sessionId: 'unknown-session', event: { type: 'turn.started', turn: 1 } }),
    ).toMatchObject({ applied: false, reason: 'no_thread_for_session' });

    const itemEvent = await board.recordRuntimeEvent({
      agentId: 'event-agent-2', sessionId: 'event-session-2',
      event: { type: 'item.completed', item: { type: 'agent_message' } },
    });
    expect(itemEvent.applied).toBe(true);
    const state = itemEvent.state!;
    expect(state.executionEvents.length).toBe(1);
  });

  it('execution events: cursor slicing and eventId dedup', async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'a', sessionId: 'ev-s1' } });
    const emit = (event: Record<string, unknown>) =>
      board.recordRuntimeEvent({ agentId: 'a', sessionId: 'ev-s1', runtimeInstanceId: 'rt-1', event });

    await emit({ type: 'turn.started', turn: 1, eventId: 'e1' });
    await emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' }, eventId: 'e2' });
    await emit({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' }, eventId: 'e2' });
    await emit({ type: 'turn.completed', turn: 1, eventId: 'e3' });

    const all = await board.getExecutionEvents(wt.threadId);
    expect(all.events.length).toBe(3, '重复 eventId 必须去重');
    expect(all.cursor).toBe(3);

    const tail = await board.getExecutionEvents(wt.threadId, { after: 2 });
    expect(tail.events.length).toBe(1);
    expect(tail.events[0].type).toBe('turn.completed');
  });

  it('execution events: monotonic absolute cursor across trim points (no loss, no dup)', { timeout: 30000 }, async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'a', sessionId: 'ev-mono' } });
    const emit = (i: number) =>
      board.recordRuntimeEvent({
        agentId: 'a', sessionId: 'ev-mono', runtimeInstanceId: 'rt-1',
        event: { type: 'item.completed', item: { id: `i-${i}`, type: 'agent_message' }, eventId: `ev-${i}` },
      });

    // 推入 620 个事件，跨裁剪点（>500 开始裁）分批增量读，模拟长期轮询消费者。
    const checkpoints = new Set([100, 300, 550, 620]);
    const seen: string[] = [];
    let cursor = 0;
    for (let i = 1; i <= 620; i++) {
      await emit(i);
      if (!checkpoints.has(i)) continue;
      const page = await board.getExecutionEvents(wt.threadId, { after: cursor });
      expect(page.cursor).toBeGreaterThan(cursor, 'cursor 必须单调递增');
      cursor = page.cursor;
      seen.push(...page.events.map((e) => e.eventId as string));
    }

    // 不丢不重：增量读拼接结果恰好是 ev-1..ev-620 各一次，顺序保持
    expect(seen.length).toBe(620);
    expect(new Set(seen).size).toBe(620, '不得重复投递');
    expect(seen).toEqual(Array.from({ length: 620 }, (_, k) => `ev-${k + 1}`));

    // 绝对游标语义：cursor = baseOffset + 窗口长度；窗口裁到最近 500 条
    expect(cursor).toBe(620);
    const state = (await board.getState(wt.threadId))!;
    expect(state.executionEvents.length).toBe(500);
    expect(state.executionEventBaseOffset).toBe(120);

    // 读尽后：空页 + cursor 稳定
    const drained = await board.getExecutionEvents(wt.threadId, { after: cursor });
    expect(drained.events).toEqual([]);
    expect(drained.cursor).toBe(620);
  });

  it('execution events: stale cursor below baseOffset returns the full current window', { timeout: 30000 }, async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'a', sessionId: 'ev-stale' } });
    for (let i = 1; i <= 520; i++) {
      await board.recordRuntimeEvent({
        agentId: 'a', sessionId: 'ev-stale', runtimeInstanceId: 'rt-1',
        event: { type: 'item.completed', item: { id: `i-${i}`, type: 'agent_message' }, eventId: `ev-${i}` },
      });
    }
    expect((await board.getState(wt.threadId))!.executionEventBaseOffset).toBe(20);

    // after=0 / after=10 均落后于窗口起点（baseOffset=20）：clamp 到窗口起点，
    // 从头返回当前可用窗口（500 条，首个是 ev-21），而非空数组静默丢读。
    for (const after of [0, 10]) {
      const page = await board.getExecutionEvents(wt.threadId, { after });
      expect(page.events.length).toBe(500);
      expect(page.events[0].eventId).toBe('ev-21');
      expect(page.cursor).toBe(520);
    }
  });

  it('execution events: cursor stays monotonic across board restart (persisted baseOffset)', { timeout: 60000 }, async () => {
    const first = makeBoardFixtures(root);
    const wt = await first.core.start({ sessionRef: { agentId: 'a', sessionId: 'ev-restart' } });
    const emit = (board: WorkThreadBoard, i: number) =>
      board.recordRuntimeEvent({
        agentId: 'a', sessionId: 'ev-restart', runtimeInstanceId: 'rt-1',
        event: { type: 'item.completed', item: { id: `i-${i}`, type: 'agent_message' }, eventId: `ev-${i}` },
      });

    for (let i = 1; i <= 520; i++) await emit(first.board, i);
    const before = await first.board.getExecutionEvents(wt.threadId, { after: 0 });
    expect(before.cursor).toBe(520);

    // 重启：同一 rootDir 下全新 store / core / board 实例，状态只从磁盘恢复
    const second = makeBoardFixtures(root);
    const restored = await second.board.getState(wt.threadId);
    expect(restored!.executionEventBaseOffset).toBe(20);
    expect(restored!.executionEvents.length).toBe(500);

    // 重启后 cursor 不回退（未持久化 baseOffset 的旧缺陷会回退到 500）
    const afterRestart = await second.board.getExecutionEvents(wt.threadId, { after: 520 });
    expect(afterRestart.events).toEqual([]);
    expect(afterRestart.cursor).toBe(520);

    // 继续追加：游标连续，增量读恰好只拿到新增事件
    for (let i = 521; i <= 530; i++) await emit(second.board, i);
    const page = await second.board.getExecutionEvents(wt.threadId, { after: 520 });
    expect(page.events.map((e) => e.eventId)).toEqual(
      Array.from({ length: 10 }, (_, k) => `ev-${521 + k}`),
    );
    expect(page.cursor).toBe(530);
    expect((await second.board.getState(wt.threadId))!.executionEventBaseOffset).toBe(30);
  });

  it('resume admits failed / waiting_input and rejects non-resumable states', async () => {
    const { core, board } = makeBoardFixtures(root);

    // failed → running：经真实 turn.failed 进入后 resume
    const t1 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s1' } });
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'rs-s1', event: { type: 'turn.started', turn: 1 } });
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'rs-s1', event: { type: 'turn.failed', turn: 1, error: { message: 'api down' } } });
    expect((await board.resume(t1.threadId)).status).toBe('running');

    // waiting_input → running：经 setStatus 播种看板状态
    const t2 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s2' } });
    await board.setStatus(t2.threadId, 'waiting_input');
    expect((await board.resume(t2.threadId)).status).toBe('running');

    // idle / running 一律拒绝
    const t3 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s3' } });
    await expect(() => board.resume(t3.threadId)).rejects.toMatchObject({ code: 'board_not_resumable' });
    const t4 = await core.start({ sessionRef: { agentId: 'a', sessionId: 'rs-s4' } });
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'rs-s4', event: { type: 'turn.started', turn: 1 } });
    await expect(() => board.resume(t4.threadId)).rejects.toMatchObject({ code: 'board_not_resumable' });
  });

  it('waiting_input is host-seeded only: event translation never produces it', async () => {
    const { core, board } = makeBoardFixtures(root);
    await core.start({ sessionRef: { agentId: 'wi-a', sessionId: 'wi-s1' } });
    const emit = (event: Record<string, unknown>) =>
      board.recordRuntimeEvent({ agentId: 'wi-a', sessionId: 'wi-s1', runtimeInstanceId: 'rt-1', event });

    // 全部受支持事件类型穷举：翻译目标态只能是 running / idle / failed 或不转换，
    // 任何事件都不产生 waiting_input（预留态唯一写入路径是 setStatus）
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'turn.started', turn: 1 }, 'running'],
      [{ type: 'item.started', item: { id: 'i1' } }, 'running'],
      [{ type: 'item.completed', item: { id: 'i1' } }, 'running'],
      [{ type: 'turn.cancelled', turn: 1 }, 'running'],
      [{ type: 'turn.completed', turn: 1 }, 'idle'],
      [{ type: 'turn.failed', turn: 2, error: { message: 'x' } }, 'failed'],
    ];
    for (const [event, expected] of cases) {
      const res = await emit(event);
      expect(res.applied).toBe(true);
      expect(res.state?.status, `after ${event.type}`).toBe(expected);
    }
  });

  it('seeded waiting_input converges coherently on subsequent runtime events', async () => {
    // 播种后三条收敛路径都必须自洽：不抛 invalid_board_transition、不卡死在预留态
    const paths: Array<[Record<string, unknown>, string]> = [
      [{ type: 'turn.started', turn: 1 }, 'running'],
      [{ type: 'turn.completed', turn: 1 }, 'idle'],
      [{ type: 'turn.failed', turn: 1, error: { message: 'x' } }, 'failed'],
    ];
    for (let k = 0; k < paths.length; k++) {
      const [event, expected] = paths[k];
      const { core, board } = makeBoardFixtures(root);
      const wt = await core.start({ sessionRef: { agentId: 'wi-b', sessionId: `wi-conv-${k}` } });
      const seeded = await board.setStatus(wt.threadId, 'waiting_input');
      expect(seeded.status).toBe('waiting_input');
      expect(seeded.lastLifecycleEvent?.type).toBe('status_seeded');

      const res = await board.recordRuntimeEvent({
        agentId: 'wi-b', sessionId: `wi-conv-${k}`, runtimeInstanceId: 'rt-1', event,
      });
      expect(res.applied, `seeded + ${event.type}`).toBe(true);
      expect(res.state?.status, `seeded + ${event.type}`).toBe(expected);
    }
  });

  it('setStatus seeds waiting_input from idle and mid-turn running', async () => {
    const { core, board } = makeBoardFixtures(root);

    // idle 途中播种
    const t1 = await core.start({ sessionRef: { agentId: 'wi-c', sessionId: 'wi-seed-1' } });
    expect((await board.setStatus(t1.threadId, 'waiting_input')).status).toBe('waiting_input');

    // running 途中播种（宿主真实场景：turn 进行中前端转入等待人工输入），turn 正常完成后收敛回 idle
    const t2 = await core.start({ sessionRef: { agentId: 'wi-c', sessionId: 'wi-seed-2' } });
    await board.recordRuntimeEvent({ agentId: 'wi-c', sessionId: 'wi-seed-2', event: { type: 'turn.started', turn: 1 } });
    expect((await board.setStatus(t2.threadId, 'waiting_input')).status).toBe('waiting_input');
    const done = await board.recordRuntimeEvent({ agentId: 'wi-c', sessionId: 'wi-seed-2', event: { type: 'turn.completed', turn: 1 } });
    expect(done.state?.status).toBe('idle');
  });

  it('closed thread rejects runtime events (board terminal)', async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'a', sessionId: 'cl-b1' } });
    await core.closeThread(wt.threadId);

    // 迟到事件被锚点 closed 判定拒绝
    expect(
      await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'cl-b1', event: { type: 'turn.started', turn: 1 } }),
    ).toMatchObject({ applied: false, reason: 'thread_closed' });
    expect(
      await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'cl-b1', event: { type: 'item.completed', item: { type: 'agent_message' } } }),
    ).toMatchObject({ applied: false, reason: 'thread_closed' });
  });

  it('closeBoard sets board terminal state', async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'a', sessionId: 'cb-1' } });
    const closed = await board.closeBoard(wt.threadId, { reason: 'user' });
    expect(closed.status).toBe('closed');
    expect(closed.lastLifecycleEvent?.type).toBe('board_closed');
    await expect(() => board.resume(wt.threadId)).rejects.toMatchObject({ code: 'thread_closed' });
  });

  it('setMode persists board mode', async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'a', sessionId: 'mode-1' } });
    // 看板状态惰性创建：首次事件建立默认 interactive
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'mode-1', event: { type: 'item.completed', item: { type: 'agent_message' } } });
    expect((await board.getState(wt.threadId))?.mode).toBe('interactive');
    await board.setMode(wt.threadId, 'autonomous');
    expect((await board.getState(wt.threadId))?.mode).toBe('autonomous');
    await expect(() => board.setMode(wt.threadId, 'bogus' as never)).rejects.toMatchObject({ code: 'invalid_board_mode' });
  });

  it('board never writes back to anchor state', async () => {
    const { core, board } = makeBoardFixtures(root);
    const wt = await core.start({ sessionRef: { agentId: 'a', sessionId: 'nb-1' } });

    // 触发一系列看板写
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'nb-1', event: { type: 'turn.started', turn: 1 } });
    await board.recordRuntimeEvent({ agentId: 'a', sessionId: 'nb-1', event: { type: 'turn.failed', turn: 1 } });
    await board.resume(wt.threadId);
    await board.setMode(wt.threadId, 'autonomous');

    // 锚点记录不受任何看板调用影响
    const anchor = await core.getThread(wt.threadId);
    expect(anchor?.headSessionId).toBe('nb-1');
    expect(anchor?.pendingSuccession).toBeNull();
    expect(anchor?.hold).toBe(false);
    expect(anchor?.status).toBe('open');
  });
});
