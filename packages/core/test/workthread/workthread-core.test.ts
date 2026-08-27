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
import { WorkThread, WorkThreadNotFoundError as CoreThreadNotFound, DEFAULT_SUCCESSION_INSTRUCTION } from '../../src/core/workthread/core.js';
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
function makeThread(
  root: string,
  bridge: WorkThreadRuntimeBridge = new WorkThreadRuntimeBridge(),
  options: { continuationPolicy?: { composeSuccessionInstruction: (ctx: { threadId: string; fromSessionId: string; reason: string }) => string } } = {},
) {
  const store = new WorkThreadStore({ rootDir: root });
  return { store, bridge, thread: new WorkThread({ store, bridge, ...options }) };
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
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2', fromSessionId: 's1', expectedRevision: 999 }),
    ).rejects.toThrow(WorkThreadRevisionConflictError);
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2', fromSessionId: 'wrong' }),
    ).rejects.toMatchObject({ code: 'head_mismatch' });

    await thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2', fromSessionId: 's1' });
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2', fromSessionId: 's2' }),
    ).rejects.toMatchObject({ code: 'already_head' });
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's1', fromSessionId: 's2' }),
    ).rejects.toMatchObject({ code: 'duplicate_session' });

    await thread.closeThread(wt.threadId);
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's3', fromSessionId: 's2' }),
    ).rejects.toMatchObject({ code: 'thread_closed' });
  });

  it('advanceHead requires fromSessionId (head CAS is mandatory, K23)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    // 缺 fromSessionId 不再是「跳过 head 校验」，而是显式 400：
    // 幽灵任务防串台不允许合法绕过。
    await expect(
      () => thread.advanceHead({ threadId: wt.threadId, toSessionId: 's2' } as any),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
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

  it('appendCommand rejects writes to a closed thread (terminal state holds)', async () => {
    // 网关队列化（R6）后线程域输入一律入 Inbox；closed 是硬终态，指令
    // 入箱只会在无投递触发的状态下永久滞留——终态禁入由对象自身把守。
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 's1' } });
    await thread.closeThread(wt.threadId, { reason: 'done' });
    await expect(() => thread.appendCommand({ threadId: wt.threadId, text: 'late' }))
      .rejects.toMatchObject({ code: 'thread_closed', status: 409 });
    const record = await thread.getThread(wt.threadId);
    expect(record!.commands.every((c) => c.text !== 'late')).toBe(true);
  });

  it('appendCommand rejects unknown kind with 400 (no silent downgrade)', async () => {
    // kind 是官方封闭词表：未知值必须当场拒绝，而不是静默降级为
    // user_message——降级会让调用方误以为自定义意图已按原样入箱。
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'k1' } });
    await expect(() => thread.appendCommand({ threadId: wt.threadId, text: 'x', kind: 'custom_kind' as never }))
      .rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    // 未传 / 空串仍按官方默认
    await thread.appendCommand({ threadId: wt.threadId, text: 'a' });
    await thread.appendCommand({ threadId: wt.threadId, text: 'b', kind: '' });
    const after = await thread.getThread(wt.threadId);
    expect(after!.commands.map((c) => c.kind)).toEqual(['user_message', 'user_message']);
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

    // head 推进：同一次落盘清除交接意图，随后投递恢复（begin 播种的恢复指令
    // 随积压一同投递，R3 前移后 delivered=2）
    const outcome = await thread.advanceHead({ threadId: wt.threadId, fromSessionId: 'hd-s1', toSessionId: 'hd-s2', endKind: 'trim' });
    expect(outcome.pendingSuccession).toBeNull();

    const delivered = await thread.deliverPendingCommands(wt.threadId);
    expect(delivered.delivered).toBe(2);
    record = await thread.getThread(wt.threadId);
    expect(record!.commands[0].status).toBe(WorkThreadCommandStatus.DELIVERED);
    expect(record!.commands[1].status).toBe(WorkThreadCommandStatus.DELIVERED);
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

describe('WorkThread succession gates (K3 / K9 / R8 / R3)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('beginSessionHandoff on held thread is rejected with thread_held (K9)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'sg-hold' } });
    await thread.setHold(wt.threadId, true);

    await expect(
      () => thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-hold', reason: 'trim' }),
    ).rejects.toMatchObject({ code: 'thread_held', status: 409 });

    const record = await thread.getThread(wt.threadId);
    expect(record!.status).toBe('open');
    expect(record!.pendingSuccession).toBeNull();
  });

  it('second begin while a fresh handoff is running is rejected, not refreshed (R8 single-flight)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'sg-conc' } });
    await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-conc', reason: 'trim' });
    const firstStartedAt = (await thread.getThread(wt.threadId))!.pendingSuccession!.startedAt;

    await expect(
      () => thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-conc', reason: 'trim' }),
    ).rejects.toMatchObject({ code: 'handoff_in_progress', status: 409 });

    const record = await thread.getThread(wt.threadId);
    expect(record!.pendingSuccession!.startedAt).toBe(firstStartedAt, '拒绝请求不得续命既有挡板时间戳');
  });

  it('begin over a stale rotating intent is allowed (recovery re-begin)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'sg-stale' } });
    await thread.store.update(wt.threadId, (draft) => {
      draft.status = 'rotating';
      draft.pendingSuccession = { fromSessionId: 'sg-stale', reason: 'trim', stage: 'started', startedAt: Date.now() - 10 * 60 * 1000 };
      return draft;
    });

    const begun = await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-stale', reason: 'manual_recovery' });
    expect(begun.status).toBe('rotating');
    expect(begun.pendingSuccession!.reason).toBe('manual_recovery');
  });

  it('beginSessionHandoff seeds the continuation instruction atomically with the barrier (R3)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'sg-seed' } });

    const begun = await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-seed', reason: 'trim' });
    const record = await thread.getThread(wt.threadId);

    const instruction = record!.commands.find((c) => c.kind === 'system_continuation');
    expect(instruction).toBeTruthy();
    expect(instruction!.idempotencyKey).toBe(`succession:${wt.threadId}:sg-seed`);
    expect(instruction!.text).toBe(DEFAULT_SUCCESSION_INSTRUCTION);
    expect(instruction!.createdAt).toBe(record!.pendingSuccession!.startedAt, '指令与挡板同拍，排序早于一切交接期积压');
    expect(begun.commands.find((c) => c.commandId === instruction!.commandId)).toBeTruthy();
  });

  it('a custom continuation policy replaces the official default text (R3)', async () => {
    const { thread } = makeThread(root, new WorkThreadRuntimeBridge(), {
      continuationPolicy: { composeSuccessionInstruction: (ctx) => `resume ${ctx.fromSessionId} (${ctx.reason})` },
    });
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'sg-policy' } });
    await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-policy', reason: 'trim' });

    const record = await thread.getThread(wt.threadId);
    expect(record!.commands.find((c) => c.kind === 'system_continuation')!.text).toBe('resume sg-policy (trim)');
  });

  it('a throwing continuation policy fails begin without persisting a barrier', async () => {
    const { thread } = makeThread(root, new WorkThreadRuntimeBridge(), {
      continuationPolicy: {
        composeSuccessionInstruction: () => { throw new Error('policy broken'); },
      },
    });
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'sg-throw' } });

    await expect(
      () => thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-throw', reason: 'trim' }),
    ).rejects.toThrow('policy broken');

    const record = await thread.getThread(wt.threadId);
    expect(record!.status).toBe('open');
    expect(record!.pendingSuccession).toBeNull();
    expect(record!.commands.length).toBe(0);
  });

  it('failSessionHandoff never overwrites a closed thread (K3 / C8)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'sg-close' } });
    await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-close', reason: 'trim' });
    await thread.closeThread(wt.threadId, { reason: 'head_session_deleted' });

    const after = await thread.failSessionHandoff(wt.threadId, { reason: 'late_failure', stage: 'advance_head' });
    expect(after.status).toBe('closed');
    expect(after.lastLifecycleEvent!.type).toBe('closed', 'closed 之上不得叠加 handoff_failed 事件');
  });

  it('failSessionHandoff without a live dossier is a no-op (K3 / C9: late loser cannot poison a healthy thread)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'sg-late' } });
    await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'sg-late', reason: 'trim' });
    // 竞争者成功推进：挡板已清、线程回到 open
    await thread.advanceHead({ threadId: wt.threadId, fromSessionId: 'sg-late', toSessionId: 'sg-late-2', endKind: 'trim' });

    const after = await thread.failSessionHandoff(wt.threadId, { reason: 'late_failure', stage: 'advance_head' });
    expect(after.status).toBe('open');
    expect(after.pendingSuccession).toBeNull();
    expect(after.lastLifecycleEvent!.type).toBe('handoff_completed');
  });

  it('failSessionHandoff on an idle open thread (no dossier ever) is a no-op (K3 / N-9)', async () => {
    const { thread } = makeThread(root);
    const wt = await thread.start({ sessionRef: { agentId: 'a', sessionId: 'sg-idle' } });

    const after = await thread.failSessionHandoff(wt.threadId, { reason: 'unwarranted', stage: 'unknown' });
    expect(after.status).toBe('open');
    expect(after.lastLifecycleEvent).toBeNull();
  });
});

describe('WorkThread delivery loop freshness (K20)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stops with head_changed when the head advances mid-loop; the rest stays pending', async () => {
    const turns: Array<Record<string, unknown>> = [];
    const { thread } = makeThread(
      root,
      new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: () => 'viewer-x',
        submitTurn: async (params) => {
          turns.push(params);
          if (turns.length === 1) {
            // 第一条投递期间换代（模拟并发 advanceHead）
            await thread.advanceHead({ threadId: wt.threadId, fromSessionId: 'dl-s1', toSessionId: 'dl-s2', endKind: 'trim' });
          }
          return { success: true };
        },
      }),
    );
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'dl-s1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: 'first', idempotencyKey: 'k1' });
    await thread.appendCommand({ threadId: wt.threadId, text: 'second', idempotencyKey: 'k2' });

    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.delivered).toBe(1);
    expect(result.reason).toBe('head_changed');

    const record = await thread.getThread(wt.threadId);
    const statuses = new Map(record!.commands.map((c) => [c.text, c.status]));
    expect(statuses.get('first')).toBe(WorkThreadCommandStatus.DELIVERED);
    expect(statuses.get('second')).toBe(WorkThreadCommandStatus.PENDING);
  });

  it('skips commands cancelled mid-loop without marking them failed', async () => {
    const { thread } = makeThread(
      root,
      new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: () => 'viewer-x',
        submitTurn: async () => ({ success: true }),
      }),
    );
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'dl-c1' } });
    const first = await thread.appendCommand({ threadId: wt.threadId, text: 'first', idempotencyKey: 'c1' });
    const second = await thread.appendCommand({ threadId: wt.threadId, text: 'second', idempotencyKey: 'c2' });

    // 首条投递期间取消第二条（模拟归档/用户取消并发）
    const bridge = thread.getBridge();
    const originalDeliver = bridge.deliver.bind(bridge);
    bridge.deliver = async (params: { command?: { commandId?: string } }) => {
      const outcome = await originalDeliver(params);
      if (params.command?.commandId === first.command.commandId) {
        await thread.cancelCommand(wt.threadId, second.command.commandId);
      }
      return outcome;
    };

    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.delivered).toBe(1);
    expect(result.results.length).toBe(1, '被取消的指令不进入结果集');

    const record = await thread.getThread(wt.threadId);
    const statuses = new Map(record!.commands.map((c) => [c.text, c.status]));
    expect(statuses.get('first')).toBe(WorkThreadCommandStatus.DELIVERED);
    expect(statuses.get('second')).toBe(WorkThreadCommandStatus.CANCELLED);
  });

  it('stops with handoff_in_progress when a handoff begins mid-loop', async () => {
    const { thread } = makeThread(
      root,
      new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: () => 'viewer-x',
        submitTurn: async () => ({ success: true }),
      }),
    );
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'dl-b1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: 'first', idempotencyKey: 'b1' });
    await thread.appendCommand({ threadId: wt.threadId, text: 'second', idempotencyKey: 'b2' });

    const bridge = thread.getBridge();
    const originalDeliver = bridge.deliver.bind(bridge);
    let deliverCount = 0;
    bridge.deliver = async (params: Parameters<typeof originalDeliver>[0]) => {
      deliverCount += 1;
      if (deliverCount === 1) {
        await thread.beginSessionHandoff({ threadId: wt.threadId, fromSessionId: 'dl-b1', reason: 'trim' });
      }
      return originalDeliver(params);
    };

    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.delivered).toBe(1);
    expect(result.reason).toBe('handoff_in_progress');
  });

  it('landing does not overwrite a cancel that lands during the command own delivery', async () => {
    // 与上一条不同窗口：cancel 发生在该指令自己的 deliver 内部——fresh 重读
    // 已读到 PENDING，投递也已在 runtime 侧完成，随后落盘阶段才并发 cancel。
    // 落盘只改 PENDING：delivered 结果不得覆写取消终态（取消意图保留）。
    const { thread } = makeThread(
      root,
      new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: () => 'viewer-x',
        submitTurn: async () => ({ success: true }),
      }),
    );
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'dl-w1' } });
    const target = await thread.appendCommand({ threadId: wt.threadId, text: 'only', idempotencyKey: 'w1' });

    const bridge = thread.getBridge();
    const originalDeliver = bridge.deliver.bind(bridge);
    bridge.deliver = async (params: Parameters<typeof originalDeliver>[0]) => {
      const outcome = await originalDeliver(params);
      if (params.command?.commandId === target.command.commandId) {
        await thread.cancelCommand(wt.threadId, target.command.commandId);
      }
      return outcome;
    };

    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.delivered).toBe(1, 'runtime 侧确实收到了投递');

    const record = await thread.getThread(wt.threadId);
    expect(record!.commands[0].status).toBe(WorkThreadCommandStatus.CANCELLED, '盘上保留取消终态，不被 delivered 覆写');
  });
});

describe('WorkThread command status contract (K8) and image passthrough', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot();
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('in_flight is no longer part of the command status vocabulary', () => {
    expect((WorkThreadCommandStatus as Record<string, string>).IN_FLIGHT).toBeUndefined();
    expect(Object.values(WorkThreadCommandStatus).sort()).toEqual(['cancelled', 'delivered', 'failed', 'pending']);
  });

  it('appendCommand carries image references and the bridge forwards them to submitTurn', async () => {
    const turns: Array<Record<string, unknown>> = [];
    const { thread } = makeThread(
      root,
      new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: () => 'viewer-img',
        submitTurn: async (params) => { turns.push(params); return { success: true }; },
      }),
    );
    const wt = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'img-s1' } });
    await thread.appendCommand({ threadId: wt.threadId, text: '看这张图', images: ['/tmp/a.png', '/tmp/b.png'] });

    const result = await thread.deliverPendingCommands(wt.threadId);
    expect(result.delivered).toBe(1);
    expect(turns[0].images).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });
});

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data), 'utf8');
}
