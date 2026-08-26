/**
 * WorkThread 锚点层测试（ticket 007）。
 *
 * 自 Claw `test/thread-control.test.js` 随迁并按职责拆分：
 * - WorkThreadStore：持久化、revision 自增、乐观并发、串行锁、无变更跳写、读时归一
 * - WorkThreadInbox：幂等入队、稳定排序、终态裁剪
 * - WorkThread：start 显式创建、head 推进事务、交接挡板、指令幂等、投递门槛、
 *   hold 开关、closeThread 收口（挂接看板的运行时事件路径测试见 board.test.ts）
 *
 * bridge 注入接口（submitTurn / resolveRuntimeViewerId / enabled）保持可 stub。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkThreadStore, WorkThreadNotFoundError, WorkThreadRevisionConflictError } from '../../src/core/workthread/store.js';
import { WorkThread, WorkThreadNotFoundError as CoreThreadNotFound } from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge } from '../../src/core/workthread/bridge.js';
import {
  appendCommand,
  createCommandRecord,
  pendingCommands,
  pruneCommands,
  WorkThreadCommandStatus,
} from '../../src/core/workthread/inbox.js';

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentdev-workthread-'));
}

/** 锚点层套件：构造 WorkThread（无看板）。 */
function makeThread(root: string, bridge: WorkThreadRuntimeBridge = new WorkThreadRuntimeBridge()) {
  const store = new WorkThreadStore({ rootDir: root });
  return { store, bridge, thread: new WorkThread({ store, bridge }) };
}

describe('WorkThreadStore', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('create / get / list roundtrip with index summary', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    const record: any = {
      threadId: 'wt-test-alpha',
      agentId: 'programming-helper',
      workspaceId: 'programming-helper',
      title: 'demo',
      status: 'open',
      rootSessionId: 'sess-1',
      headSessionId: 'sess-1',
      sessionChain: [
        { sessionId: 'sess-1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null },
      ],
      commands: [],
      pendingSuccession: null,
      hold: false,
      lifecycleEvents: [],
      lastLifecycleEvent: null,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    await store.create(record);

    const loaded = await store.get('wt-test-alpha');
    expect(loaded?.headSessionId).toBe('sess-1');

    const list = (await store.list()) as Array<{ threadId: string; sessionIds: string[]; headSessionId: string; chainEdges: unknown[] }>;
    const entry = list.find((t) => t.threadId === 'wt-test-alpha');
    expect(entry).toBeTruthy();
    expect(entry!.sessionIds).toEqual(['sess-1']);
    expect(entry!.headSessionId).toBe('sess-1');
    // root 棒无接力边
    expect(entry!.chainEdges).toEqual([]);
  });

  it('remove deletes record file and index entry; absent thread is idempotent success', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    const makeRecord = (threadId: string, sessionId: string): any => ({
      threadId,
      agentId: 'programming-helper',
      workspaceId: 'programming-helper',
      title: '',
      status: 'open',
      rootSessionId: sessionId,
      headSessionId: sessionId,
      sessionChain: [
        { sessionId, role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null },
      ],
      commands: [],
      pendingSuccession: null,
      hold: false,
      lifecycleEvents: [],
      lastLifecycleEvent: null,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.create(makeRecord('wt-remove-me', 'sess-rm'));
    await store.create(makeRecord('wt-keep', 'sess-keep'));

    const removed = await store.remove('wt-remove-me');
    expect(removed).toEqual({ removed: true, alreadyAbsent: false });
    expect(await store.get('wt-remove-me')).toBeNull();
    const list = (await store.list()) as Array<{ threadId: string }>;
    expect(list.some((t) => t.threadId === 'wt-remove-me')).toBe(false);
    // 并发创建的其它线程 index 条目不受删除影响（同 _indexLock 串行链）
    expect(list.some((t) => t.threadId === 'wt-keep')).toBe(true);

    // 幂等：不存在视为已删除（宿主级联删除的重试收敛终态）
    const again = await store.remove('wt-remove-me');
    expect(again).toEqual({ removed: false, alreadyAbsent: true });

    // 非法 id：明确失败而不是静默成功
    await expect(store.remove('')).rejects.toBeInstanceOf(WorkThreadNotFoundError);
  });

  it('index summary exposes relay edges for non-root legs', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    const record: any = {
      threadId: 'wt-relay',
      agentId: 'coder',
      workspaceId: 'coder',
      title: '',
      status: 'open',
      rootSessionId: 's1',
      headSessionId: 's3',
      sessionChain: [
        { sessionId: 's1', role: 'predecessor', startedAt: 1, endedAt: 2, endKind: 'trim', successorSessionId: 's2' },
        { sessionId: 's2', role: 'predecessor', startedAt: 2, endedAt: 3, endKind: 'summary', successorSessionId: 's3' },
        { sessionId: 's3', role: 'head', startedAt: 3, endedAt: null, endKind: null, successorSessionId: null },
      ],
      commands: [],
      pendingSuccession: null,
      hold: false,
      lifecycleEvents: [],
      lastLifecycleEvent: null,
      revision: 3,
      createdAt: 1,
      updatedAt: 3,
    };
    await store.create(record);

    const list = (await store.list()) as Array<{ threadId: string; chainEdges: unknown[] }>;
    const entry = list.find((t) => t.threadId === 'wt-relay');
    expect(entry).toBeTruthy();
    // 非 root 棒各带来源与方式
    expect(entry!.chainEdges).toEqual([
      { sessionId: 's2', fromSessionId: 's1', relayKind: 'trim' },
      { sessionId: 's3', fromSessionId: 's2', relayKind: 'summary' },
    ]);
  });

  it('update bumps revision and persists mutation', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    const record: any = {
      threadId: 'wt-rev', agentId: 'a', workspaceId: 'a', title: '', status: 'open',
      rootSessionId: 's1', headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [], pendingSuccession: null, hold: false, lifecycleEvents: [], lastLifecycleEvent: null,
      revision: 1, createdAt: 1, updatedAt: 1,
    };
    await store.create(record);

    const { record: updated, changed } = await store.update('wt-rev', (draft) => {
      draft.title = 'renamed';
      return draft;
    });
    expect(changed).toBe(true);
    expect(updated.revision).toBe(2);

    const reloaded = await store.get('wt-rev');
    expect(reloaded?.title).toBe('renamed');
    expect(reloaded?.revision).toBe(2);
  });

  it('no-op mutation is skipped (changed: false, revision unchanged)', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    const before = await store.get('wt-rev');
    const { record, changed } = await store.update('wt-rev', (draft) => draft);
    expect(changed).toBe(false);
    expect(record.revision).toBe(before!.revision);
  });

  it('expectedRevision mismatch raises conflict', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    await expect(
      () => store.update('wt-rev', (draft) => draft, { expectedRevision: 999 }),
    ).rejects.toThrow(WorkThreadRevisionConflictError);
  });

  it('missing thread raises WorkThreadNotFoundError', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    await expect(() => store.update('wt-missing', (d) => d)).rejects.toThrow(WorkThreadNotFoundError);
  });

  it('concurrent updates serialize without lost writes', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    const record: any = {
      threadId: 'wt-conc', agentId: 'a', workspaceId: 'a', title: '', status: 'open',
      rootSessionId: 's1', headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [], pendingSuccession: null, hold: false, lifecycleEvents: [], lastLifecycleEvent: null,
      revision: 1, createdAt: 1, updatedAt: 1,
    };
    await store.create(record);

    await Promise.all([
      store.update('wt-conc', (d) => { d.title = 'first'; return d; }),
      store.update('wt-conc', (d) => { (d as any).workspaceId = 'autonomous'; return d; }),
    ]);

    const final = await store.get('wt-conc');
    expect(final!.revision).toBe(3);
    expect(final!.title).toBe('first');
    expect(final!.workspaceId).toBe('autonomous');
  });

  it('legacy thread statuses are normalized on read and on create', async () => {
    const store = new WorkThreadStore({ rootDir: root });
    const base: any = {
      agentId: 'a', workspaceId: 'a', title: '', rootSessionId: 's1', headSessionId: 's1',
      sessionChain: [{ sessionId: 's1', role: 'head', startedAt: 1, endedAt: null, endKind: null, successorSessionId: null }],
      commands: [], pendingSuccession: null, hold: false, lifecycleEvents: [], lastLifecycleEvent: null,
      revision: 1, createdAt: 1, updatedAt: 1,
    };

    // 盘上旧值（旧状态空间）读时归一到新锚点域
    const cases: Array<[string, string, string]> = [
      ['wt-legacy-active', 'active', 'open'],
      ['wt-legacy-completed', 'completed', 'closed'],
      ['wt-legacy-cancelled', 'cancelled', 'closed'],
      ['wt-legacy-blocked', 'blocked', 'open'],
    ];
    for (const [threadId, written, expected] of cases) {
      await mkdir(join(root, 'threads'), { recursive: true });
      await writeJson(join(root, 'threads', `${threadId}.json`), { ...base, threadId, status: written });
      expect((await store.get(threadId))?.status).toBe(expected);
    }

    // create 入口同样归一
    await store.create({ ...base, threadId: 'wt-create-legacy', status: 'active' });
    expect((await store.get('wt-create-legacy'))?.status).toBe('open');
    const indexEntry = (await store.list()) as Array<{ threadId: string; status: string }>;
    expect(indexEntry.find((t) => t.threadId === 'wt-create-legacy')?.status).toBe('open');
  });
});

describe('WorkThreadInbox helpers', () => {
  it('pendingCommands sorts by createdAt then commandId', () => {
    const record = {
      commands: [
        { commandId: 'b', createdAt: 2, status: 'pending' },
        { commandId: 'a', createdAt: 1, status: 'pending' },
        { commandId: 'c', createdAt: 1, status: 'delivered' },
      ],
    };
    const pending = pendingCommands(record as any);
    expect(pending.map((c) => c.commandId)).toEqual(['a', 'b']);
  });

  it('pruneCommands drops oldest terminal commands beyond retention', () => {
    const commands: any[] = [];
    for (let i = 0; i < 12; i++) {
      commands.push({ commandId: `cmd-${i}`, status: WorkThreadCommandStatus.DELIVERED, createdAt: i, updatedAt: i });
    }
    commands.push({ commandId: 'keep-me', status: WorkThreadCommandStatus.PENDING, createdAt: 99, updatedAt: 99 });

    const record = { commands };
    const changed = pruneCommands(record as any, 5);
    expect(changed).toBe(true);
    expect(record.commands.length).toBe(6); // 5 terminal + 1 pending
    expect(record.commands.some((c) => c.commandId === 'keep-me')).toBe(true);
    expect(!record.commands.some((c) => c.commandId === 'cmd-0')).toBe(true); // 最旧被裁
  });

  it('appendCommand without idempotencyKey always appends', () => {
    const record: any = { commands: [] };
    const c1 = createCommandRecord({ threadId: 't', text: 'a' });
    const c2 = createCommandRecord({ threadId: 't', text: 'b' });
    expect(appendCommand(record, c1).duplicate).toBe(false);
    expect(appendCommand(record, c2).duplicate).toBe(false);
    expect(record.commands.length).toBe(2);
  });

  it('appendCommand is idempotent by idempotencyKey', () => {
    const record: any = { commands: [] };
    const c1 = createCommandRecord({ threadId: 't', text: 'x', idempotencyKey: 'k1' });
    const c2 = createCommandRecord({ threadId: 't', text: 'x', idempotencyKey: 'k1' });
    const first = appendCommand(record, c1);
    const second = appendCommand(record, c2);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.command.commandId).toBe(second.command.commandId);
  });
});

describe('WorkThread (anchor layer)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('start seeds root/head and chain (explicit opt-in)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'sess-a' }, title: '修复登录' });
    expect(wt.threadId).toMatch(/^wt-/);
    expect(wt.headSessionId).toBe('sess-a');
    expect(wt.rootSessionId).toBe('sess-a');
    expect(wt.sessionChain.length).toBe(1);
    expect(wt.sessionChain[0].role).toBe('head');
    expect(wt.status).toBe('open');
  });

  it('start rejects invalid identifiers', async () => {
    const { thread } = makeThread(root);
    await expect(thread.start({ sessionRef: { agentId: '', sessionId: 's' } } as any)).rejects.toThrow();
    await expect(thread.start({ sessionRef: { agentId: 'a', sessionId: 'bad id with spaces' } } as any)).rejects.toThrow();
  });

  it('advanceHead closes old chain entry and moves head atomically', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });

    const advanced = await thread.advanceHead({
      threadId: wt.threadId,
      toSessionId: 's2',
      fromSessionId: 's1',
      expectedRevision: wt.revision,
      endKind: 'context_rotation',
    });

    expect(advanced.headSessionId).toBe('s2');
    expect(advanced.sessionChain.length).toBe(2);
    const oldHead = advanced.sessionChain[0];
    expect(oldHead.role).toBe('predecessor');
    expect(oldHead.endKind).toBe('context_rotation');
    expect(oldHead.successorSessionId).toBe('s2');
    expect(advanced.sessionChain[1].role).toBe('head');
  });

  it('advanceHead guards: stale revision / wrong from / duplicate target / non-active', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });

    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2', expectedRevision: 999 }),
    ).rejects.toThrow(WorkThreadRevisionConflictError);
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2', fromSessionId: 'wrong' }),
    ).rejects.toMatchObject({ code: 'head_mismatch' });

    await thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2' });
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2' }),
    ).rejects.toMatchObject({ code: 'already_head' });
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's1' }),
    ).rejects.toMatchObject({ code: 'duplicate_session' });

    await thread.closeThread(wt.threadId);
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's3' }),
    ).rejects.toMatchObject({ code: 'thread_closed' });
  });

  it('closeThread closes and cancels pending commands', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: 'x', idempotencyKey: 'k1' });

    const closed = await thread.closeThread(wt.threadId, { reason: 'user' });
    expect(closed.status).toBe('closed');
    expect(closed.commands[0].status).toBe(WorkThreadCommandStatus.CANCELLED);
  });

  it('closeThread is terminal: idempotent close', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'cl-s1' } });
    const first = await thread.closeThread(wt.threadId, { reason: 'user' });
    expect(first.status).toBe('closed');
    expect(first.closeReason).toBe('user');
    const second = await thread.closeThread(wt.threadId, { reason: 'again' });
    expect(second.status).toBe('closed');
    expect(second.closeReason).toBe('user', '重复 close 幂等，不改写首个 closeReason');
  });

  it('cancelCommand only affects pending', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    const { command } = await thread.appendCommand({ threadId: wt.threadId, text: 'x' });

    await thread.cancelCommand(wt.threadId, command.commandId);
    await thread.cancelCommand(wt.threadId, command.commandId); // 二次取消幂等

    const record = await thread.getThread(wt.threadId);
    expect(record!.commands[0].status).toBe(WorkThreadCommandStatus.CANCELLED);
  });

  it('appendCommand is idempotent by idempotencyKey', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });

    const first = await thread.appendCommand({ threadId: wt.threadId, text: '请继续', idempotencyKey: 'ui-1' });
    const second = await thread.appendCommand({ threadId: wt.threadId, text: '请继续', idempotencyKey: 'ui-1' });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.command.commandId).toBe(second.command.commandId);

    const record = await thread.getThread(wt.threadId);
    expect(record!.commands.length).toBe(1);
  });

  it('appendCommand rejects empty text and unknown thread', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    await expect(() => thread.appendCommand({ threadId: wt.threadId, text: '   ' })).rejects.toThrow();
    await expect(() => thread.appendCommand({ threadId: 'wt-none', text: 'x' })).rejects.toThrow(
      CoreThreadNotFound,
    );
  });

  it('findThreadByHeadSession returns full record for current head only', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'h1' } });
    const found = await thread.findThreadByHeadSession('a', 'h1');
    expect(found?.threadId).toBe(wt.threadId);
    expect(await thread.findThreadByHeadSession('a', 'nope')).toBeNull();
    expect(await thread.findThreadByHeadSession('', 'h1')).toBeNull();
  });
});

describe('WorkThread delivery gating (anchor layer only)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('deliverPendingCommands with dormant bridge keeps commands pending', async () => {
    const { thread } = makeThread(root); // bridge enabled=false
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: '请继续' });

    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.reason).toBe('bridge_disabled');
    expect(result.delivered).toBe(0);

    const record = await thread.getThread(wt.threadId);
    expect(record!.commands[0].status).toBe(WorkThreadCommandStatus.PENDING);
  });

  it('closed gates delivery with thread_closed', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'g-s1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: 'x' });
    await thread.closeThread(wt.threadId);
    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.delivered).toBe(0);
    expect(result.reason).toBe('thread_closed');
  });

  it('active handoff gates delivery with handoff_in_progress', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'g-s1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: 'x' });
    await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'g-s1', reason: 'trim' });

    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.delivered).toBe(0);
    expect(result.reason).toBe('handoff_in_progress');
    const record = await thread.getThread(wt.threadId);
    expect(record!.commands[0].status).toBe(WorkThreadCommandStatus.PENDING);
  });

  it('hold gates delivery with thread_held and persists', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'h-s1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: 'x' });

    await thread.setHold(wt.threadId, true);
    const held = await thread.deliverPendingCommands(wt.threadId);
    expect(held.delivered).toBe(0);
    expect(held.reason).toBe('thread_held');

    // 落盘第一等：重启不丢
    const reloaded = await thread.getThread(wt.threadId);
    expect(reloaded!.hold).toBe(true);

    // 清除后恢复
    await thread.setHold(wt.threadId, false);
    const again = await thread.deliverPendingCommands(wt.threadId);
    expect(again.delivered).toBe(0);
    expect(again.reason).toBe('bridge_disabled'); // dormant bridge
  });

  it('stale handoff intent no longer blocks delivery (failure-path self-healing)', async () => {
    const turns: Array<Record<string, unknown>> = [];
    const { thread } = makeThread(
      root,
      new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: () => 'viewer-x',
        submitTurn: async (params) => { turns.push(params); return { success: true }; },
      }),
    );
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'hd-stale' } });
    await thread.appendCommand({ threadId: wt.threadId, text: 'later' });

    // 直接写一个 10 分钟前的交接意图（模拟 compact 崩溃后残留）
    await thread.store.update(wt.threadId, (draft) => {
      draft.pendingSuccession = { fromSessionId: 'hd-stale', reason: 'trim', startedAt: Date.now() - 10 * 60 * 1000 };
      return draft;
    });

    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.delivered).toBe(1);
    const record = await thread.getThread(wt.threadId);
    expect(record!.pendingSuccession).toBeNull(); // 惰性清除落盘
  });

  it('beginSessionHandoff blocks delivery; advanceHead clears atomically and resumes', async () => {
    const turns: Array<Record<string, unknown>> = [];
    const { thread } = makeThread(
      root,
      new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: (agentId, sessionId) => (sessionId === 'hd-s2' ? 'viewer-s2' : null),
        submitTurn: async (params) => { turns.push(params); return { success: true }; },
      }),
    );
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'hd-s1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: '请继续' });

    const begun = await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'hd-s1', reason: 'trim' });
    expect(begun.status).toBe('rotating');

    const blocked = await thread.deliverPendingCommands(wt.threadId);
    expect(blocked.delivered).toBe(0);
    expect(blocked.reason).toBe('handoff_in_progress');
    let record = await thread.getThread(wt.threadId);
    expect(record!.commands[0].status).toBe(WorkThreadCommandStatus.PENDING);
    expect(record!.pendingSuccession!.fromSessionId).toBe('hd-s1');

    // head 推进：同一次落盘清除交接意图，随后投递恢复
    const outcome = await thread.advanceHead({ threadId: wt.threadId, fromSessionId: 'hd-s1', toSessionId: 'hd-s2', endKind: 'trim' });
    expect(outcome.pendingSuccession).toBeNull();

    const delivered = await thread.deliverPendingCommands(wt.threadId);
    expect(delivered.delivered).toBe(1);
    record = await thread.getThread(wt.threadId);
    expect(record!.commands[0].status).toBe(WorkThreadCommandStatus.DELIVERED);
  });

  it('advanceHead lands on open with pendingSuccession cleared atomically', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'ah-s1' } });
    await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'ah-s1', reason: 'context_guard' });

    const advanced = await thread.advanceHead({
      threadId: wt.threadId,
      toSessionId: 'ah-s2',
      fromSessionId: 'ah-s1',
      endKind: 'trim',
    });
    expect(advanced.status).toBe('open');
    expect(advanced.pendingSuccession).toBeNull();
    expect(advanced.lastLifecycleEvent?.type).toBe('handoff_completed');
  });

  it('rotation failure path: rotating → rotation_failed with pendingSuccession preserved', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'rot-s1' } });

    const begun = await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'rot-s1', reason: 'context_guard' });
    expect(begun.status).toBe('rotating');
    expect(begun.pendingSuccession!.fromSessionId).toBe('rot-s1');
    expect(begun.lastLifecycleEvent?.type).toBe('handoff_started');

    const failed = await thread.failSessionHandoff(wt.threadId, {
      reason: 'compact_crashed',
      stage: 'compact_or_successor',
      error: 'mirror timeout',
    });
    expect(failed.status).toBe('rotation_failed');
    expect(failed.pendingSuccession!.fromSessionId).toBe('rot-s1', '交接意图必须保留在盘上');
    expect(failed.lastLifecycleEvent?.reason).toBe('compact_crashed');
    expect(failed.lastLifecycleEvent?.stage).toBe('compact_or_successor');
  });
});

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data), 'utf8');
}
