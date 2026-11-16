/**
 * WorkThread 原子接续提交与 unresolved 一等事实测试（ADR-0047 阶段 2a）。
 *
 * commitSessionSuccession：head 推进 + 挡板清除 + 退役棒指令消费分类 +
 * unresolved 持久化在同一次 store.update 内完成——任一环节失败整体丢弃。
 * 分类语义与宿主判定闸同源（决策 2）：缺可靠消费引用不构成未消费证明，
 * 无法判定 → unresolved（不失败、不重放、不静默滞留）。
 *
 * 处置（resolveUnresolved）：consumed / discard / reissue 都是显式决定；
 * reissue 是 de4d5d03 重投路径的显式化，幂等键换新避免命中旧命令去重。
 *
 * 看板完整性（readStateDetailed / quarantineBoard）：missing 与 corrupt
 * 结构化区分；corrupt 隔离保留证物，隔离后按 missing 惰性重建。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkThreadStore } from '../../src/core/workthread/store.js';
import { WorkThread, WorkThreadNotFoundError } from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge } from '../../src/core/workthread/bridge.js';
import { WorkThreadBoard } from '../../src/core/workthread/board.js';
import {
  WorkThreadCommandStatus,
  classifyRetiredCommands,
  createCommandRecord,
  createUnresolvedRecord,
  openUnresolvedCommands,
  pruneCommands,
  pruneResolvedUnresolved,
  WORKTHREAD_SUCCESSION_REASONS,
  type SuccessionEvidence,
  type WorkThreadCommand,
} from '../../src/core/workthread/inbox.js';

async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `agentdev-succession-${prefix}-`));
}

function makeThread(root: string, options: ConstructorParameters<typeof WorkThread>[0] = {}) {
  const store = new WorkThreadStore({ rootDir: root });
  const thread = new WorkThread({ store, bridge: new WorkThreadRuntimeBridge(), ...options });
  return { store, thread };
}

/**
 * 在盘上把一条 pending 指令直接标记为 delivered（等价于投递成功后的
 * 落盘事实），deliveredAt 可显式指定以控制它落在哪一棒的存续窗内。
 */
async function markDelivered(
  store: WorkThreadStore,
  threadId: string,
  commandId: string,
  deliveredAt: number,
): Promise<void> {
  await store.update(threadId, (draft) => {
    const command = (draft.commands || []).find((c) => c.commandId === commandId);
    if (!command) throw new Error(`command ${commandId} not found`);
    command.status = WorkThreadCommandStatus.DELIVERED;
    command.deliveredAt = deliveredAt;
    command.updatedAt = deliveredAt;
    return draft;
  });
}

/** integrity ok 的证据快照：给 retiredSessionId 注入携带可靠消费引用的 turn 事件。 */
function evidenceWithRefs(retiredSessionId: string, refs: string[]): SuccessionEvidence {
  return {
    integrity: 'ok',
    events: refs.map((ref) => ({
      sessionId: retiredSessionId,
      event: { type: 'turn.started', turn: 1, sourceRef: ref },
    })),
  };
}

describe('commitSessionSuccession (ADR-0047 stage 2)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot('commit');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a commit without a begun handoff with the actionable code and no disk changes', async () => {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 'not-begun' } });
    const before = await store.get(started.threadId);
    await expect(thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: 'not-begun',
      toSessionId: 'not-begun-successor',
    })).rejects.toMatchObject({ code: 'handoff_not_started', status: 409 });
    expect(await new WorkThreadStore({ rootDir: root }).get(started.threadId)).toEqual(before);
  });

  it('classifies all candidates consumed when every delivered command has a reliable reference', async () => {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1' } });
    const appended = await thread.appendCommand({ threadId: started.threadId, text: 'do work' });
    await markDelivered(store, started.threadId, appended.command.commandId, Date.now());

    await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: 's1', seedContinuation: false });
    const out = await thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: 's1',
      toSessionId: 's2',
      evidence: evidenceWithRefs('s1', [appended.command.commandId]),
    });

    expect(out.record.headSessionId).toBe('s2');
    expect(out.unresolved).toEqual([]);
    expect(out.consumedCommandIds).toEqual([appended.command.commandId]);
    // 已消费指令保持 delivered 终态（不是删除，不是重投）
    const command = (out.record.commands || []).find((c) => c.commandId === appended.command.commandId);
    expect(command?.status).toBe(WorkThreadCommandStatus.DELIVERED);
    expect(out.record.unresolvedCommands ?? []).toEqual([]);
  });

  it('persists unresolved with full payload when a delivered command lacks a consumption reference', async () => {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1' } });
    const appended = await thread.appendCommand({
      threadId: started.threadId,
      text: 'restart the build',
      capabilityActivations: ['plan-mode'],
      images: ['shot.png'],
      metadata: { ticket: 47 },
      originSourceRef: 'evt-9',
    });
    const deliveredAt = Date.now();
    await markDelivered(store, started.threadId, appended.command.commandId, deliveredAt);

    // 窗口可见（该棒有事件）但指令无可靠引用
    await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: 's1', seedContinuation: false });
    const out = await thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: 's1',
      toSessionId: 's2',
      evidence: evidenceWithRefs('s1', ['cmd-someone-else']),
    });

    expect(out.record.headSessionId).toBe('s2');
    expect(out.consumedCommandIds).toEqual([]);
    expect(out.unresolved).toHaveLength(1);
    const unresolved = out.unresolved[0];
    expect(unresolved.reason).toBe(WORKTHREAD_SUCCESSION_REASONS.NO_POSITIVE_REFERENCE);
    expect(unresolved.commandId).toBe(appended.command.commandId);
    expect(unresolved.fromHeadSessionId).toBe('s1');
    // 载荷完整快照：处置（reissue）不依赖原指令仍在 commands 里
    expect(unresolved.text).toBe('restart the build');
    expect(unresolved.capabilityActivations).toEqual(['plan-mode']);
    expect(unresolved.images).toEqual(['shot.png']);
    expect(unresolved.metadata).toEqual({ ticket: 47 });
    expect(unresolved.originSourceRef).toBe('evt-9');
    expect(unresolved.resolvedAt).toBeNull();
    // 指令本体保持 delivered（unresolved 是侧写，不改写终态）
    const command = (out.record.commands || []).find((c) => c.commandId === appended.command.commandId);
    expect(command?.status).toBe(WorkThreadCommandStatus.DELIVERED);
    // 审计：lifecycle 记录 unresolved_created
    expect(out.record.lifecycleEvents.some((e) => e.type === 'unresolved_created')).toBe(true);
  });

  it('marks every candidate unresolved when evidence is missing (default), corrupt, or the bar has no events', async () => {
    for (const scenario of [
      { name: 'no evidence passed (default)', evidence: undefined, reason: WORKTHREAD_SUCCESSION_REASONS.EVIDENCE_MISSING },
      { name: 'corrupt board file', evidence: { integrity: 'corrupt', events: [] } as SuccessionEvidence, reason: WORKTHREAD_SUCCESSION_REASONS.EVIDENCE_CORRUPT },
      { name: 'no events for retired bar', evidence: { integrity: 'ok', events: [] } as SuccessionEvidence, reason: WORKTHREAD_SUCCESSION_REASONS.NO_EVENTS_FOR_BAR },
    ]) {
      const { store, thread } = makeThread(root);
      const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1' } });
      const appended = await thread.appendCommand({ threadId: started.threadId, text: 'x' });
      await markDelivered(store, started.threadId, appended.command.commandId, Date.now());

      await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: 's1', seedContinuation: false });
      const out = await thread.commitSessionSuccession({
        threadId: started.threadId,
        fromSessionId: 's1',
        toSessionId: 's2',
        evidence: scenario.evidence,
      });
      expect(out.record.headSessionId, scenario.name).toBe('s2');
      expect(out.unresolved.map((u) => u.reason), scenario.name).toEqual([scenario.reason]);
    }
  });

  it('advances without evidence when no delivered command falls in the retired bar window', async () => {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1' } });
    // delivered 指令投递时间早于本棒 startedAt（属于上一棒）
    const earlyBarStart = 1_000;
    const appended = await thread.appendCommand({ threadId: started.threadId, text: 'old bar work' });
    await markDelivered(store, started.threadId, appended.command.commandId, earlyBarStart);

    await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: 's1', seedContinuation: false });
    const out = await thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: 's1',
      toSessionId: 's2',
      evidence: { integrity: 'missing', events: [] },
    });
    expect(out.record.headSessionId).toBe('s2');
    expect(out.unresolved).toEqual([]);
  });

  it('rejects with revision conflict and leaves disk unchanged when expectedRevision is stale', async () => {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1' } });
    const appended = await thread.appendCommand({ threadId: started.threadId, text: 'x' });
    await markDelivered(store, started.threadId, appended.command.commandId, Date.now());

    await expect(thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: 's1',
      toSessionId: 's2',
      expectedRevision: 1, // 已过期（start / append / markDelivered 均已递增）
      evidence: evidenceWithRefs('s1', []),
    })).rejects.toMatchObject({ code: 'revision_conflict' });

    // 原子性：磁盘无任何变更——head 未推进、无 unresolved
    const after = await store.get(started.threadId);
    expect(after?.headSessionId).toBe('s1');
    expect(after?.unresolvedCommands ?? []).toEqual([]);
  });

  it('drops the whole draft (no head advance, no unresolved) when the transaction body fails mid-way', async () => {
    const rootIso = await makeTempRoot('iso');
    try {
      // identitySource 让身份校验在 reduce 之后失败 → store.update 整体丢弃
      const { store, thread } = makeThread(rootIso, {
        identitySource: async () => null, // session_workspace_mismatch
      });
      const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1' } });
      const appended = await thread.appendCommand({ threadId: started.threadId, text: 'x' });
      await markDelivered(store, started.threadId, appended.command.commandId, Date.now());

      await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: 's1', seedContinuation: false });
      await expect(thread.commitSessionSuccession({
        threadId: started.threadId,
        fromSessionId: 's1',
        toSessionId: 's2',
        evidence: { integrity: 'missing', events: [] },
      })).rejects.toMatchObject({ code: 'session_workspace_mismatch' });

      const after = await store.get(started.threadId);
      expect(after?.headSessionId).toBe('s1');
      expect(after?.unresolvedCommands ?? []).toEqual([]);
    } finally {
      await rm(rootIso, { recursive: true, force: true });
    }
  });

  it('rejects retry after a committed transaction: no handoff and no duplicate unresolved', async () => {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1' } });
    const appended = await thread.appendCommand({ threadId: started.threadId, text: 'x' });
    await markDelivered(store, started.threadId, appended.command.commandId, Date.now());

    await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: 's1', seedContinuation: false });
    const first = await thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: 's1',
      toSessionId: 's2',
      evidence: { integrity: 'missing', events: [] },
    });
    expect(first.unresolved).toHaveLength(1);

    // 模拟崩溃窗口后的重试：同一参数再来一次
    await expect(thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: 's1',
      toSessionId: 's2',
      evidence: { integrity: 'missing', events: [] },
    })).rejects.toMatchObject({ code: 'handoff_not_started' });

    const after = await store.get(started.threadId);
    expect(after?.headSessionId).toBe('s2');
    expect(openUnresolvedCommands(after ?? {})).toHaveLength(1);
  });
});

describe('resolveUnresolved / listUnresolved (ADR-0047 stage 2)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot('resolve');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function threadWithOneUnresolved(tag: string) {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: `s1-${tag}` } });
    const appended = await thread.appendCommand({
      threadId: started.threadId,
      text: `payload ${tag}`,
      images: ['a.png'],
      metadata: { tag },
    });
    await markDelivered(store, started.threadId, appended.command.commandId, Date.now());
    await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: `s1-${tag}`, seedContinuation: false });
    const out = await thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: `s1-${tag}`,
      toSessionId: `s2-${tag}`,
      evidence: { integrity: 'missing', events: [] },
    });
    return { store, thread, threadId: started.threadId, unresolved: out.unresolved[0], command: appended.command, successor: `s2-${tag}` };
  }

  it('resolves as consumed: marks the record, clears open list, idempotent on repeat', async () => {
    const { thread, threadId, unresolved } = await threadWithOneUnresolved('consumed');
    const out = await thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'consumed', note: 'verified in old transcript',
    });
    expect(out.record.unresolvedCommands?.[0]?.resolution).toBe('consumed');
    expect(await thread.listUnresolved(threadId)).toEqual([]);

    // 幂等：重复相同处置返回现状，不抛错
    const again = await thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'consumed',
    });
    expect(again.record.unresolvedCommands?.[0]?.resolution).toBe('consumed');

    // 冲突：换一种处置被拒
    await expect(thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'discard',
    })).rejects.toMatchObject({ code: 'unresolved_already_resolved' });
  });

  it('resolves as reissue: enqueues a new pending command with full payload and a fresh idempotency key', async () => {
    const { thread, threadId, unresolved, successor } = await threadWithOneUnresolved('reissue');
    const out = await thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'reissue', note: 'operator replay',
    });
    expect(out.command).toBeTruthy();
    expect(out.command?.status).toBe(WorkThreadCommandStatus.PENDING);
    expect(out.command?.text).toBe('payload reissue');
    expect(out.command?.images).toEqual(['a.png']);
    expect(out.command?.metadata).toEqual({ tag: 'reissue', reissueOf: unresolved.commandId });
    // 幂等键必须换新：沿用旧键会命中 appendCommand 对 delivered 的去重
    expect(out.command?.idempotencyKey).not.toBe(unresolved.idempotencyKey);
    expect(out.command?.idempotencyKey).toBe(`reissue-${unresolved.unresolvedId}`);
    // unresolved 标记收口
    expect(out.record.unresolvedCommands?.[0]?.resolution).toBe('reissue');
    expect(await thread.listUnresolved(threadId)).toEqual([]);

    // 幂等：重复 reissue 不再入箱，但返回既有重投指令（幂等重试的调用方
    // 不因重复请求丢失指令句柄——阶段 2b 审查修正）
    const again = await thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'reissue',
    });
    expect(again.command?.commandId).toBe(out.command?.commandId);
    const pendings = (again.record.commands || []).filter((c) => c.status === WorkThreadCommandStatus.PENDING);
    expect(pendings).toHaveLength(1);

    // 新指令属于当前 head 棒（successor），不受 retired 棒窗口影响
    expect(successor).toBe(out.record.headSessionId);
  });

  it('returns a reissue handle that is the actual enqueued entity (no phantom success)', async () => {
    const { thread, threadId, unresolved } = await threadWithOneUnresolved('reissue');
    const out = await thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'reissue',
    });
    // 返回句柄必须真实入箱：收口为 reissued 但 record 中无此指令 = 假成功
    // （阶段 2a 审查发现：append 幂等命中时新建对象未入箱，句柄指向幽灵）。
    expect(out.command?.commandId).toBeTruthy();
    const enqueued = (out.record.commands || []).find(
      (c) => c.commandId === out.command?.commandId,
    );
    expect(enqueued).toBeTruthy();
    expect(enqueued?.idempotencyKey).toBe(`reissue-${unresolved.unresolvedId}`);
  });

  it('rejects ordinary commands squatting the reserved reissue- idempotency prefix', async () => {
    const { thread, threadId } = await threadWithOneUnresolved('pending');
    // 键空间保留：调用方预占 reissue-<id> 会让真正的重投静默并入无关命令，
    // 必须在入箱前显式拒绝（appendCommand 守卫 + 事务回滚）。
    await expect(thread.appendCommand({
      threadId,
      text: 'squatting command',
      kind: 'user_message',
      idempotencyKey: 'reissue-some-unresolved-id',
    })).rejects.toMatchObject({ code: 'invalid_request' });
    // 事务回滚：违规命令未入箱
    const record = await thread.getThread(threadId);
    expect((record.commands || []).some((c) => c.text === 'squatting command')).toBe(false);
  });

  it('refuses to close a reissue resolution when the reserved key is occupied by an unrelated command', async () => {
    const { thread, store, threadId, unresolved } = await threadWithOneUnresolved('occupied');
    // 构造损坏态：无关 pending 命令占用了该 unresolved 的重投键（正常路径
    // 被前缀守卫阻断；此用例锁定损坏态防御——不得收口、不得返回假句柄）。
    await store.update(threadId, (draft) => {
      const squatter = createCommandRecord({
        threadId, text: 'unrelated squatter', kind: 'user_message',
        idempotencyKey: `reissue-${unresolved.unresolvedId}`,
      });
      draft.commands = [...(draft.commands || []), squatter];
      return draft;
    });
    await expect(thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'reissue',
    })).rejects.toMatchObject({ code: 'inconsistent_state' });
    // 抛错即整次事务回滚：unresolved 保持未处置（不因幽灵收口丢失待核对事实）
    const after = await thread.listUnresolved(threadId);
    expect(after.map((u) => u.unresolvedId)).toContain(unresolved.unresolvedId);
    expect(after[0]?.resolution ?? null).toBeNull();
    // 占用命令原样保留（防御路径不吞任何既有数据）
    const record = await thread.getThread(threadId);
    expect((record.commands || []).filter((c) => c.text === 'unrelated squatter')).toHaveLength(1);
  });

  it('rejects reissue on closed threads but allows discard (archive-time cleanup)', async () => {
    const { thread, threadId, unresolved } = await threadWithOneUnresolved('closed');
    await thread.closeThread(threadId);
    await expect(thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'reissue',
    })).rejects.toMatchObject({ code: 'thread_closed' });
    const out = await thread.resolveUnresolved({
      threadId, unresolvedId: unresolved.unresolvedId, resolution: 'discard', note: 'superseded',
    });
    expect(out.record.unresolvedCommands?.[0]?.resolution).toBe('discard');
  });

  it('throws typed not-found for unknown unresolved ids', async () => {
    const { thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1-nf' } });
    await expect(thread.resolveUnresolved({
      threadId: started.threadId, unresolvedId: 'unres-nope', resolution: 'consumed',
    })).rejects.toMatchObject({ code: 'unresolved_not_found' });
  });
});

describe('pruneCommands exemption (ADR-0047 stage 2)', () => {
  function deliveredCommand(id: string, updatedAt: number, deliveredAt: number): WorkThreadCommand {
    const command = createCommandRecord({ threadId: 'wt-x', text: `cmd ${id}` });
    command.commandId = id;
    command.status = WorkThreadCommandStatus.DELIVERED;
    command.updatedAt = updatedAt;
    command.deliveredAt = deliveredAt;
    return command;
  }

  it('never prunes commands referenced by an open unresolved record', () => {
    const old = deliveredCommand('old', 1, 1);
    const guarded = deliveredCommand('guarded', 2, 2);
    const record = {
      commands: [old, guarded],
      sessionChain: [{ sessionId: 's-new', startedAt: 1_000, endedAt: null }],
      headSessionId: 's-new',
      unresolvedCommands: [createUnresolvedRecord(guarded, 's-old', WORKTHREAD_SUCCESSION_REASONS.NO_POSITIVE_REFERENCE)],
    };
    // maxRetained=0：全部超限，但被 open unresolved 引用的必须留下
    const changed = pruneCommands(record, 0);
    expect(changed).toBe(true);
    expect(record.commands.map((c) => c.commandId)).toEqual(['guarded']);
  });

  it('never prunes delivered commands of the current head bar (not yet classified by any succession)', () => {
    const old = deliveredCommand('old', 1, 1);
    const current = deliveredCommand('current', 2, 1_500);
    const record = {
      commands: [old, current],
      sessionChain: [{ sessionId: 's-new', startedAt: 1_000, endedAt: null }],
      headSessionId: 's-new',
    };
    pruneCommands(record, 0);
    expect(record.commands.map((c) => c.commandId)).toEqual(['current']);
  });

  it('never prunes delivered commands without deliveredAt even outside the head bar (stage 5 review P2-9)', () => {
    // deliveredAt 缺失的 delivered 指令等待下一次接续分类转 unresolved
    // （reason=unattributable）。提前裁掉 = 永久丢失恢复依据——即使它
    // 的 updatedAt 早于 head 棒（换算上像旧棒指令）也保守豁免。
    const noat = deliveredCommand('no-timestamp', 1, 0);
    const record = {
      commands: [noat],
      sessionChain: [{ sessionId: 's-new', startedAt: 1_000, endedAt: null }],
      headSessionId: 's-new',
    };
    expect(pruneCommands(record, 0)).toBe(false); // 全量超限但唯一项被豁免：无内容变更
    expect(record.commands.map((c) => c.commandId)).toEqual(['no-timestamp']);
  });

  it('resumes pruning a command once its unresolved record is resolved', () => {
    const guarded = deliveredCommand('guarded', 2, 2);
    const record = {
      commands: [guarded],
      sessionChain: [{ sessionId: 's-new', startedAt: 1_000, endedAt: null }],
      headSessionId: 's-new',
      unresolvedCommands: [createUnresolvedRecord(guarded, 's-old', WORKTHREAD_SUCCESSION_REASONS.NO_POSITIVE_REFERENCE)],
    };
    pruneCommands(record, 0);
    expect(record.commands.map((c) => c.commandId)).toEqual(['guarded']);
    // 处置后（resolvedAt 置位、无 open 引用），且命令不在当前棒 → 恢复可裁
    record.unresolvedCommands![0].resolvedAt = Date.now();
    pruneCommands(record, 0);
    expect(record.commands).toEqual([]);
  });

  it('prunes resolved unresolved records beyond the retention cap, never open ones', () => {
    const command = deliveredCommand('c', 1, 1);
    const record: { commands: WorkThreadCommand[]; unresolvedCommands: Array<ReturnType<typeof createUnresolvedRecord>> } = {
      commands: [command],
      unresolvedCommands: [],
    };
    for (let i = 0; i < 205; i += 1) {
      const unresolved = createUnresolvedRecord(command, 's-old', WORKTHREAD_SUCCESSION_REASONS.EVIDENCE_MISSING);
      if (i < 3) {
        // 3 条 open：永不裁剪
      } else {
        unresolved.resolvedAt = 1_000 + i;
        unresolved.resolution = 'consumed';
        unresolved.updatedAt = 1_000 + i;
      }
      record.unresolvedCommands.push(unresolved);
    }
    const changed = pruneResolvedUnresolved(record, 200);
    expect(changed).toBe(true);
    const open = record.unresolvedCommands.filter((u) => !u.resolvedAt);
    const resolved = record.unresolvedCommands.filter((u) => u.resolvedAt);
    expect(open).toHaveLength(3);
    expect(resolved).toHaveLength(200);
  });
});

describe('composeNotice in-transaction notice (stage 2b review: crash window)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot('notice');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * 场景基线：一条 delivered 无证据指令 + missing 证据 → commit 产生
   * unresolved。composeNotice 在事务内被调用，返回的文本作为
   * system_continuation 指令与换头/unresolved 同事务入箱。
   */
  async function commitWithNotice(tag: string, composeNotice?: (u: unknown[]) => { text: string } | null) {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: `s1-${tag}` } });
    const appended = await thread.appendCommand({ threadId: started.threadId, text: `payload ${tag}` });
    await markDelivered(store, started.threadId, appended.command.commandId, Date.now());
    await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: `s1-${tag}`, seedContinuation: false });
    const out = await thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: `s1-${tag}`,
      toSessionId: `s2-${tag}`,
      evidence: { integrity: 'missing', events: [] },
      ...(composeNotice ? { composeNotice } : {}),
    });
    return { thread, threadId: started.threadId, out };
  }

  it('appends the notice command in the same transaction as head advance (no post-commit window)', async () => {
    const { thread, threadId, out } = await commitWithNotice('txn', (u) => {
      expect(Array.isArray(u) && u.length).toBe(1);
      return { text: `核对 ${u.length} 条未决指令` };
    });
    // 事务返回后通知已在 record：崩溃点在 commit 之后也不丢失强制发现
    const notices = (out.record.commands || []).filter(
      (c) => c.kind === 'system_continuation' && c.text.includes('核对 1 条未决指令'),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.idempotencyKey).toBe(`succession-notice:${threadId}:s2-txn`);
    expect(out.record.headSessionId).toBe('s2-txn');
  });

  it('rolls back the whole succession when composeNotice throws (no head advance, no unresolved)', async () => {
    const { store, thread } = makeThread(root);
    const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1-throw' } });
    const appended = await thread.appendCommand({ threadId: started.threadId, text: 'payload throw' });
    await markDelivered(store, started.threadId, appended.command.commandId, Date.now());
    // composeNotice 抛错 = 整体失败：换头未发生、无 unresolved、无通知指令
    await thread.beginSessionHandoff({ threadId: started.threadId, fromSessionId: 's1-throw', seedContinuation: false });
    await expect(thread.commitSessionSuccession({
      threadId: started.threadId,
      fromSessionId: 's1-throw',
      toSessionId: 's2-throw',
      evidence: { integrity: 'missing', events: [] },
      composeNotice: () => { throw new Error('notice composition failed'); },
    })).rejects.toThrow('notice composition failed');
    const record = await thread.getThread(started.threadId);
    expect(record.headSessionId).toBe('s1-throw');
    expect(record.unresolvedCommands ?? []).toHaveLength(0);
    expect((record.commands || []).some((c) => c.kind === 'system_continuation')).toBe(false);
    expect((record.commands || []).some((c) => c.status === 'pending')).toBe(false);
  });

  it('skips the notice when composeNotice returns null (manual no-broadcast path)', async () => {
    const { out } = await commitWithNotice('manual', () => null);
    expect((out.record.commands || []).filter((c) => c.kind === 'system_continuation')).toHaveLength(0);
    expect(out.unresolved).toHaveLength(1);
  });

  it('keeps unresolved persisted even when the caller crashes after commit (retry is CAS-rejected, facts survive)', async () => {
    const { thread, threadId } = await commitWithNotice('crash', () => ({ text: 'notice' }));
    // 模拟调用方 commit 返回后崩溃重启，重试同一提交：挡板已清，拒绝再次提交，
    // 但持久事实（unresolved + 通知指令）已在此前事务中落盘——不依赖重试补建。
    await expect(thread.commitSessionSuccession({
      threadId,
      fromSessionId: 's1-crash',
      toSessionId: 's2-crash',
      evidence: { integrity: 'missing', events: [] },
      composeNotice: () => ({ text: 'duplicate notice' }),
    })).rejects.toMatchObject({ code: 'handoff_not_started' });
    const record = await thread.getThread(threadId);
    const notices = (record.commands || []).filter((c) => c.idempotencyKey === `succession-notice:${threadId}:s2-crash`);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toBe('notice');
    expect((record.unresolvedCommands ?? []).filter((u) => !u.resolvedAt)).toHaveLength(1);
  });
});

describe('board integrity signal & quarantine (ADR-0047 stage 2)', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRoot('board');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeBoard(root: string) {
    const store = new WorkThreadStore({ rootDir: root });
    const core = new WorkThread({ store, bridge: new WorkThreadRuntimeBridge() });
    return { core, board: new WorkThreadBoard({ core, rootDir: root }) };
  }

  it('readStateDetailed distinguishes ok / missing / corrupt', async () => {
    const { core, board } = makeBoard(root);
    const wt = await core.start({ sessionRef: { agentId: 'b1', sessionId: 'bs1' } });

    expect(await board.readStateDetailed(wt.threadId)).toMatchObject({ integrity: 'missing' });

    await board.recordRuntimeEvent({
      agentId: 'b1', sessionId: 'bs1', runtimeInstanceId: 'r1',
      event: { type: 'turn.started', turn: 1 },
    });
    expect(await board.readStateDetailed(wt.threadId)).toMatchObject({ integrity: 'ok' });

    // 写入损坏内容：文件存在但解析失败
    const boardFile = join(root, 'boards', `${wt.threadId}.board.json`);
    await writeFile(boardFile, '{ not valid json', 'utf8');
    const detailed = await board.readStateDetailed(wt.threadId);
    expect(detailed.integrity).toBe('corrupt');
    if (detailed.integrity === 'corrupt') expect(detailed.error).toBeTruthy();
    // getState 保持既有契约：吞成 null（消费方逐步迁移）
    expect(await board.getState(wt.threadId)).toBeNull();
  });

  it('quarantines a corrupt board: renames to evidence file, next read is missing', async () => {
    const { core, board } = makeBoard(root);
    const wt = await core.start({ sessionRef: { agentId: 'b3', sessionId: 'bs3' } });
    const boardFile = join(root, 'boards', `${wt.threadId}.board.json`);
    await writeFile(boardFile, 'corrupt payload', 'utf8');

    const out = await board.quarantineBoard(wt.threadId);
    expect(out.quarantined).toBe(true);
    expect(out.quarantinePath).toBeTruthy();
    // 证物保留
    const evidence = await readFile(out.quarantinePath!, 'utf8');
    expect(evidence).toBe('corrupt payload');
    // 原位置不再有状态文件；后续读取为 missing
    const names = await readdir(join(root, 'boards'));
    expect(names.includes(`${wt.threadId}.board.json`)).toBe(false);
    expect(await board.readStateDetailed(wt.threadId)).toMatchObject({ integrity: 'missing' });
  });

  it('leaves intact boards alone (quarantine is explicit evidence-loss, not maintenance)', async () => {
    const { core, board } = makeBoard(root);
    const wt = await core.start({ sessionRef: { agentId: 'b4', sessionId: 'bs4' } });
    await board.recordRuntimeEvent({
      agentId: 'b4', sessionId: 'bs4', runtimeInstanceId: 'r1',
      event: { type: 'turn.started', turn: 1 },
    });
    const out = await board.quarantineBoard(wt.threadId);
    expect(out).toMatchObject({ quarantined: false, outcome: 'intact' });
    expect(await board.readStateDetailed(wt.threadId)).toMatchObject({ integrity: 'ok' });
  });
});

describe('classifyRetiredCommands pure layer', () => {
  it('excludes pending, failed, cancelled, and continuation commands from candidates', () => {
    const barStart = 1_000;
    const record = {
      commands: [
        { ...createCommandRecord({ threadId: 'wt', text: 'pending' }), commandId: 'c-pending', deliveredAt: null },
        { ...createCommandRecord({ threadId: 'wt', text: 'failed' }), commandId: 'c-failed', status: WorkThreadCommandStatus.FAILED, deliveredAt: barStart + 1 },
        { ...createCommandRecord({ threadId: 'wt', text: 'cancelled' }), commandId: 'c-cancelled', status: WorkThreadCommandStatus.CANCELLED, deliveredAt: barStart + 1 },
        {
          ...createCommandRecord({ threadId: 'wt', kind: 'system_continuation', text: 'cont' }),
          commandId: 'c-cont', status: WorkThreadCommandStatus.DELIVERED, deliveredAt: barStart + 1,
        },
      ],
      sessionChain: [{ sessionId: 's1', startedAt: barStart, endedAt: 2_000 }],
    };
    const out = classifyRetiredCommands(record, 's1', evidenceWithRefs('s1', []));
    expect(out.consumedCommandIds).toEqual([]);
    expect(out.undecidable).toEqual([]);
  });

  it('rejects unreadable evidence as a contract violation (retryable semantics belong to the commit layer)', () => {
    const record = { commands: [], sessionChain: [{ sessionId: 's1', startedAt: 1, endedAt: 2 }] };
    expect(() => classifyRetiredCommands(record, 's1', { integrity: 'unreadable', events: [] }))
      .toThrowError(expect.objectContaining({ code: 'invalid_evidence_integrity' }));
  });

  it('routes delivered commands without deliveredAt to unresolved as unattributable instead of silently dropping them (stage 5 review P2-9)', () => {
    // deliveredAt 缺失 = 无法归属任何棒窗口。旧实现把它当「窗口外」静默
    // 跳过：换头后该指令从恢复面消失（非 consumed、非 unresolved、非
    // pending——查无处可查）。正确语义是转 unresolved（reason=
    // unattributable），由调度面人工/再issue处置；pruneCommands 对其
    // 保守豁免，恢复依据不丢。
    const barStart = 1_000;
    const record = {
      commands: [
        {
          ...createCommandRecord({ threadId: 'wt', text: 'no timestamp' }),
          commandId: 'c-noat', status: WorkThreadCommandStatus.DELIVERED, deliveredAt: null,
        },
        {
          ...createCommandRecord({ threadId: 'wt', kind: 'system_continuation', text: 'notice also lacks deliveredAt' }),
          commandId: 'c-notice', status: WorkThreadCommandStatus.DELIVERED, deliveredAt: null,
        },
      ],
      sessionChain: [{ sessionId: 's1', startedAt: barStart, endedAt: 2_000 }],
    };
    const out = classifyRetiredCommands(record, 's1', evidenceWithRefs('s1', []));
    expect(out.consumedCommandIds).toEqual([]);
    expect(out.undecidable).toHaveLength(1);
    expect(out.undecidable[0]).toMatchObject({
      command: { commandId: 'c-noat' },
      reason: WORKTHREAD_SUCCESSION_REASONS.UNATTRIBUTABLE,
    });
  });

  it('rejects a retired session that is not a chain member instead of widening the window to infinity', () => {
    const record = { commands: [], sessionChain: [{ sessionId: 's1', startedAt: 1, endedAt: 2 }] };
    expect(() => classifyRetiredCommands(record, 's-not-in-chain', evidenceWithRefs('s-not-in-chain', [])))
      .toThrowError(expect.objectContaining({ code: 'invalid_retired_bar' }));
  });

  it('snapshots metadata deep: later in-place edits on the source command do not leak into the unresolved record', () => {
    const base = createCommandRecord({ threadId: 'wt', text: 'x' });
    base.metadata = { nested: { value: 1 } };
    const unresolved = createUnresolvedRecord(base, 's1', WORKTHREAD_SUCCESSION_REASONS.NO_POSITIVE_REFERENCE);
    base.metadata.nested.value = 999;
    expect(unresolved.metadata).toEqual({ nested: { value: 1 } });
  });
});

describe('evidence unreadable rejection (stage 2a review)', () => {
  it('commitSessionSuccession refuses to advance when evidence is unreadable: retryable 409, no unresolved, head unchanged', async () => {
    const root = await makeTempRoot('unreadable');
    try {
      const { store, thread } = makeThread(root);
      const started = await thread.start({ sessionRef: { agentId: 'a1', sessionId: 's1' } });
      const tid = started.threadId;
      const appended = await thread.appendCommand({ threadId: tid, text: 'do work', source: 'api' });
      await markDelivered(store, tid, appended.command.commandId, Date.now());

      await thread.beginSessionHandoff({ threadId: tid, fromSessionId: 's1', seedContinuation: false });
      const err = await thread.commitSessionSuccession({
        threadId: tid,
        fromSessionId: 's1',
        toSessionId: 's2',
        evidence: { integrity: 'unreadable', events: [], note: 'EPERM' },
      }).catch((e: Error & { code?: string; status?: number }) => e);
      expect(err).toMatchObject({ code: 'evidence_unreadable', status: 409 });

      // 磁盘事实：head 未推进、无 unresolved（拒绝不是 unresolved 承接）
      const after = await thread.getThread(tid);
      expect(after?.headSessionId).toBe('s1');
      expect(after?.unresolvedCommands ?? []).toEqual([]);
      // 证据恢复（可读）后重试成功：换头推进，缺引用指令进 unresolved。
      // 注入一条无关指令的引用：窗口可见（touched）但该指令无可靠引用，
      // 精确走 no_positive_reference 分支。
      const retried = await thread.commitSessionSuccession({
        threadId: tid,
        fromSessionId: 's1',
        toSessionId: 's2',
        evidence: evidenceWithRefs('s1', ['other-command-ref']),
      });
      expect(retried.record.headSessionId).toBe('s2');
      expect(retried.unresolved.map((u) => u.reason)).toEqual([WORKTHREAD_SUCCESSION_REASONS.NO_POSITIVE_REFERENCE]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('pruneCommands anomaly conservatism (stage 2a review)', () => {
  it('keeps every delivered command when the head bar entry is missing from the chain (data anomaly)', () => {
    const commands: WorkThreadCommand[] = [];
    for (let i = 0; i < 250; i += 1) {
      const record = createCommandRecord({ threadId: 'wt', text: `c${i}` });
      record.status = WorkThreadCommandStatus.DELIVERED;
      record.deliveredAt = 1_000 + i;
      commands.push(record);
    }
    // headSessionId 指向的条目不在 chain 上：数据异常。保守豁免全部
    // delivered——裁掉待分类指令等于永久丢失恢复依据。
    const record = {
      commands,
      headSessionId: 's-head',
      sessionChain: [{ sessionId: 's-other', startedAt: 900, endedAt: null }],
    };
    expect(pruneCommands(record, 200)).toBe(false);
    expect(record.commands.length).toBe(250);
  });
});
