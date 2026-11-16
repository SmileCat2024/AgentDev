/**
 * WorkThread 并发、故障恢复与 unresolved 保留性质测试。
 *
 * 语义锚点：AgentDevClaw docs/reference/thread-state-matrix.md 的 M3-RACE、M3-NO-HANDOFF、
 * M5-IDEM，以及 ADR-0047 §3、§5「原子换头」「待核对不得静默重放/裁剪」。
 * 不建模生产转换表；随机化只覆盖有效载荷和合法接续链，竞态通过真实 Store/Core 的
 * promise gate 排序，不使用时间延迟。测试没有覆盖真实断电或 Viewer 接收端去重。
 */

import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkThread } from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge } from '../../src/core/workthread/bridge.js';
import { createCommandRecord, WorkThreadCommandStatus } from '../../src/core/workthread/inbox.js';
import { WorkThreadStore, type WorkThreadRecord } from '../../src/core/workthread/store.js';

class InjectedStore extends WorkThreadStore {
  loseNextUpdateResponse = false;

  override async update(
    threadId: string,
    mutFn: (record: WorkThreadRecord) => WorkThreadRecord | null | undefined | Promise<WorkThreadRecord | null | undefined>,
    options: { expectedRevision?: number } = {},
  ): Promise<{ record: WorkThreadRecord; changed: boolean }> {
    const result = await super.update(threadId, mutFn, options);
    if (this.loseNextUpdateResponse) {
      this.loseNextUpdateResponse = false;
      throw new Error('injected response loss after durable store update');
    }
    return result;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeCore(root: string, store: WorkThreadStore = new WorkThreadStore({ rootDir: root })) {
  return { store, core: new WorkThread({ store, bridge: new WorkThreadRuntimeBridge() }) };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function markDelivered(store: WorkThreadStore, threadId: string, commandId: string): Promise<void> {
  await store.update(threadId, (record) => {
    const command = record.commands.find((entry) => entry.commandId === commandId);
    if (!command) throw new Error(`missing command ${commandId}`);
    command.status = WorkThreadCommandStatus.DELIVERED;
    command.deliveredAt = Date.now();
    command.updatedAt = command.deliveredAt;
    return record;
  });
}

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentdev-workthread-recovery-'));
  roots.push(root);
  return root;
}

async function start(root: string, sessionId = 's0') {
  const { core, store } = makeCore(root);
  const thread = await core.start({ sessionRef: { agentId: 'recovery-agent', sessionId } });
  return { core, store, threadId: thread.threadId };
}

async function appendDelivered(core: WorkThread, store: WorkThreadStore, threadId: string, text: string, metadata: Record<string, unknown> = {}) {
  const appended = await core.appendCommand({ threadId, text, metadata, images: ['original.png'], capabilityActivations: ['plan-mode'], originSourceRef: 'origin-1' });
  await markDelivered(store, threadId, appended.command.commandId);
  return appended.command;
}

async function beginAndCommit(core: WorkThread, threadId: string, from: string, to: string, composeNotice?: () => { text: string } | null) {
  await core.beginSessionHandoff({ threadId, fromSessionId: from, seedContinuation: false });
  return core.commitSessionSuccession({
    threadId,
    fromSessionId: from,
    toSessionId: to,
    evidence: { integrity: 'missing', events: [] },
    ...(composeNotice ? { composeNotice } : {}),
  });
}

describe('WorkThread 恢复性质（ADR-0047 / thread-state-matrix）', () => {
  it('M3-RACE：并发同 from 提交恰一赢家，head/chain/命令/unresolved 无半套', async () => {
    const payloadArb = fc.array(
      fc.string({ minLength: 1, maxLength: 20 }).filter((text) => text.trim().length > 0),
      { minLength: 1, maxLength: 5 },
    );
    await fc.assert(fc.asyncProperty(
      payloadArb,
      fc.integer({ min: 2, max: 5 }),
      fc.boolean(),
      async (payloads, competitorCount, reverseOrder) => {
      const root = await freshRoot();
      const { core, store, threadId } = await start(root);
      const originals = [];
      for (const text of payloads) originals.push(await appendDelivered(core, store, threadId, text));
      await core.beginSessionHandoff({ threadId, fromSessionId: 's0', seedContinuation: false });

      const scheduled = Array.from({ length: competitorCount }, (_, index) => `s${index + 1}`);
      if (reverseOrder) scheduled.reverse();
      const outcomes = await Promise.allSettled(scheduled.map((toSessionId) => core.commitSessionSuccession({
        threadId, fromSessionId: 's0', toSessionId,
        evidence: { integrity: 'missing', events: [] },
      })));
      expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(competitorCount - 1);
      const winnerIndex = outcomes.findIndex((item) => item.status === 'fulfilled');
      const winner = outcomes[winnerIndex];
      const losers = outcomes.filter((item) => item.status === 'rejected');
      expect(winner?.status).toBe('fulfilled');
      expect(losers.every((loser) => loser.status === 'rejected' && errorCode(loser.reason) === 'handoff_not_started')).toBe(true);
      if (winner?.status !== 'fulfilled') throw new Error('race winner missing');
      expect(winner.value.record.headSessionId).toBe(scheduled[winnerIndex]);

      const record = await new WorkThreadStore({ rootDir: root }).get(threadId);
      expect(winner.value.record).toEqual(record);
      expect(record).not.toBeNull();
      expect(record?.headSessionId).toBe(scheduled[winnerIndex]);
      expect(record?.sessionChain).toHaveLength(2);
      expect(record?.sessionChain.filter((entry) => entry.role === 'head')).toHaveLength(1);
      expect(record?.sessionChain.at(-1)?.sessionId).toBe(record?.headSessionId);
      expect(record?.pendingSuccession).toBeNull();
      expect(record?.commands.filter((entry) => entry.kind === 'system_continuation')).toHaveLength(0);
      const unresolved = record?.unresolvedCommands?.filter((entry) => !entry.resolvedAt) ?? [];
      expect(unresolved).toHaveLength(payloads.length);
      expect(unresolved).toEqual(winner.value.unresolved);
      expect(new Set(unresolved.map((entry) => entry.commandId)).size).toBe(payloads.length);
      expect(unresolved.map((entry) => entry.commandId).sort()).toEqual(originals.map((entry) => entry.commandId).sort());
      expect(unresolved.map((entry) => entry.text).sort()).toEqual(payloads.slice().sort());
      expect(record?.commands.filter((entry) => entry.status === WorkThreadCommandStatus.DELIVERED)).toHaveLength(payloads.length);
    }), { numRuns: 8 });
  });

  it('M5-IDEM：并发 reissue 同一 unresolved 只产生一条真实 pending 命令', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 10 }), async (requestCount) => {
      const root = await freshRoot();
      const { core, store, threadId } = await start(root);
      const original = await appendDelivered(core, store, threadId, 'reissue this instruction', { nested: { ticket: 9 } });
      const committed = await beginAndCommit(core, threadId, 's0', 's1');
      const unresolved = committed.unresolved[0];
      const requests = Array.from({ length: requestCount }, () => core.resolveUnresolved({
        threadId, unresolvedId: unresolved.unresolvedId, resolution: 'reissue',
      }));
      const settled = await Promise.allSettled(requests);
      expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
      const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      expect(results).toHaveLength(requests.length);
      expect(new Set(results.map((result) => result.command?.commandId)).size).toBe(1);
      const record = await store.get(threadId);
      const reissues = record?.commands.filter((command) => command.metadata?.reissueOf === original.commandId) ?? [];
      expect(reissues).toHaveLength(1);
      expect(reissues[0]).toMatchObject({ status: WorkThreadCommandStatus.PENDING, text: 'reissue this instruction', images: ['original.png'], capabilityActivations: ['plan-mode'], originSourceRef: 'origin-1' });
      expect(reissues[0]?.metadata).toEqual({ nested: { ticket: 9 }, reissueOf: original.commandId });
      expect(record?.unresolvedCommands?.find((item) => item.unresolvedId === unresolved.unresolvedId)?.resolution).toBe('reissue');
    }), { numRuns: 4 });
  });

  it('close/reissue 的两个排队方向均可串行化，close 必成功且未决事实不丢', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (closeFirst) => {
      const root = await freshRoot();
      const { core, store, threadId } = await start(root);
      const original = await appendDelivered(core, store, threadId, 'must remain addressable');
      const { unresolved } = await beginAndCommit(core, threadId, 's0', 's1');
      const reissue = () => core.resolveUnresolved({ threadId, unresolvedId: unresolved[0].unresolvedId, resolution: 'reissue' });
      const close = () => core.closeThread(threadId);
      const first = closeFirst ? close() : reissue();
      const second = closeFirst ? reissue() : close();
      const outcomes = await Promise.allSettled([first, second]);
      const closeOutcome = outcomes[closeFirst ? 0 : 1];
      const reissueOutcome = outcomes[closeFirst ? 1 : 0];
      expect(closeOutcome?.status).toBe('fulfilled');
      expect(reissueOutcome?.status).toBe(closeFirst ? 'rejected' : 'fulfilled');
      const record = await store.get(threadId);
      expect(record?.status).toBe('closed');
      const item = record?.unresolvedCommands?.find((entry) => entry.unresolvedId === unresolved[0].unresolvedId);
      expect(item).toBeTruthy();
      const reissues = record?.commands.filter((command) => command.metadata?.reissueOf === original.commandId) ?? [];
      if (closeFirst) {
        if (reissueOutcome?.status !== 'rejected') throw new Error('close-first must reject reissue');
        expect(errorCode(reissueOutcome.reason)).toBe('thread_closed');
        expect(item?.resolvedAt).toBeNull();
        expect(reissues).toEqual([]);
      } else {
        if (reissueOutcome?.status !== 'fulfilled') throw new Error('reissue-first must resolve');
        expect(item?.resolution).toBe('reissue');
        expect(reissues).toHaveLength(1);
        expect(reissues[0]?.status).toBe(WorkThreadCommandStatus.CANCELLED);
      }
      expect(await makeCore(root).core.listUnresolved(threadId)).toHaveLength(item?.resolvedAt ? 0 : 1);
    }), { numRuns: 2, examples: [[true], [false]] });
  });

  it('事务体失败整体回滚；提交落盘但响应丢失后重载与重试不重复事实', async () => {
    const root = await freshRoot();
    const injected = new InjectedStore({ rootDir: root });
    const core = new WorkThread({ store: injected, bridge: new WorkThreadRuntimeBridge() });
    const started = await core.start({ sessionRef: { agentId: 'recovery-agent', sessionId: 's0' } });
    const threadId = started.threadId;
    const original = await appendDelivered(core, injected, threadId, 'uncertain payload', { case: 'fault' });

    await core.beginSessionHandoff({ threadId, fromSessionId: 's0', seedContinuation: false });
    const beforeFailure = await injected.get(threadId);
    await expect(core.commitSessionSuccession({
      threadId, fromSessionId: 's0', toSessionId: 's1', evidence: { integrity: 'missing', events: [] },
      composeNotice: () => { throw new Error('transaction body failure'); },
    })).rejects.toThrow('transaction body failure');
    const rolledBack = await new WorkThreadStore({ rootDir: root }).get(threadId);
    expect(rolledBack).toEqual(beforeFailure);

    // 前一次事务体失败留下的 handoff 仍是合法活动前置。注入点在真实
    // store.update 完成原子写之后，模拟调用方响应丢失，不冒充中途断电。
    injected.loseNextUpdateResponse = true;
    await expect(core.commitSessionSuccession({
      threadId, fromSessionId: 's0', toSessionId: 's1', evidence: { integrity: 'missing', events: [] },
      composeNotice: () => ({ text: 'inspect unresolved' }),
    })).rejects.toThrow('injected response loss');

    const restarted = makeCore(root).core;
    const afterLostResponse = await restarted.getThread(threadId);
    if (!afterLostResponse) throw new Error('committed thread missing after response loss');
    expect(afterLostResponse.headSessionId).toBe('s1');
    expect(afterLostResponse.pendingSuccession).toBeNull();
    expect(afterLostResponse.unresolvedCommands?.filter((entry) => !entry.resolvedAt)).toHaveLength(1);
    expect(afterLostResponse.unresolvedCommands?.[0]).toMatchObject({
      commandId: original.commandId, text: 'uncertain payload', metadata: { case: 'fault' },
      images: ['original.png'], capabilityActivations: ['plan-mode'], originSourceRef: 'origin-1',
    });
    expect(afterLostResponse.commands.filter((entry) => entry.idempotencyKey === `succession-notice:${threadId}:s1`)).toHaveLength(1);

    await expect(restarted.commitSessionSuccession({
      threadId, fromSessionId: 's0', toSessionId: 's1', evidence: { integrity: 'missing', events: [] },
    })).rejects.toMatchObject({ code: 'handoff_not_started' });
    const afterRetry = await restarted.getThread(threadId);
    expect(afterRetry).toEqual(afterLostResponse);
  });

  it('未决载荷跨多次接续、hold、重载与命令裁剪保持可寻址，显式处置前不消失', async () => {
    const depthArb = fc.integer({ min: 2, max: 4 });
    await fc.assert(fc.asyncProperty(depthArb, async (depth) => {
      const root = await freshRoot();
      let { core, store, threadId } = await start(root);
      const original = await appendDelivered(core, store, threadId, 'original full payload', { nested: { keep: ['a', 'b'] } });
      let from = 's0';
      const unresolvedIds: string[] = [];
      for (let index = 1; index <= depth; index += 1) {
        const to = `s${index}`;
        const commit = await beginAndCommit(core, threadId, from, to);
        unresolvedIds.push(...commit.unresolved.map((entry) => entry.unresolvedId));
        expect(commit.unresolved).toHaveLength(index === 1 ? 1 : 0);
        from = to;
        core = makeCore(root).core;
        store = new WorkThreadStore({ rootDir: root });
        await core.setHold(threadId, true);
        expect(await core.listUnresolved(threadId)).toHaveLength(1);
        await core.setHold(threadId, false);
      }

      // 一次真实 store.update 播种超额历史；经公开 append 触发生产 prune，
      // 避免 215 次双文件 I/O。历史仅作为裁剪压力夹具，不声称是有效操作序列。
      await store.update(threadId, (record) => {
        record.commands.push(...Array.from({ length: 215 }, (_, index) => {
          const command = createCommandRecord({ threadId, text: `settled-history-${index}` });
          command.commandId = `settled-history-${index}`;
          command.idempotencyKey = `settled-history-key-${index}`;
          command.status = WorkThreadCommandStatus.FAILED;
          command.createdAt = index;
          command.updatedAt = index;
          return command;
        }));
        return record;
      });
      const seededCount = (await store.get(threadId))?.commands.filter((entry) => entry.commandId.startsWith('settled-history-')).length ?? 0;
      expect(seededCount).toBe(215);
      await core.appendCommand({ threadId, text: 'trigger real command pruning' });
      const afterObservedPrune = await store.get(threadId);
      const settledAfterPrune = afterObservedPrune?.commands.filter((entry) => entry.commandId.startsWith('settled-history-')).length ?? 0;
      expect(settledAfterPrune).toBeLessThan(seededCount);
      core = makeCore(root).core;
      const record = await core.getThread(threadId);
      if (!record) throw new Error('thread missing after pruning');
      expect(record.unresolvedCommands?.filter((entry) => !entry.resolvedAt).map((entry) => entry.unresolvedId)).toEqual(unresolvedIds);
      expect(record.unresolvedCommands?.[0]).toMatchObject({
        commandId: original.commandId, text: 'original full payload', metadata: { nested: { keep: ['a', 'b'] } },
        images: ['original.png'], capabilityActivations: ['plan-mode'], originSourceRef: 'origin-1', resolvedAt: null,
      });
      expect(record.commands.some((entry) => entry.commandId === original.commandId)).toBe(true);
      expect(await core.listUnresolved(threadId)).toHaveLength(1);

      await core.resolveUnresolved({ threadId, unresolvedId: unresolvedIds[0]!, resolution: 'consumed', note: 'explicitly reconciled' });
      core = makeCore(root).core;
      const clearedId = unresolvedIds[0]!;
      expect(await core.listUnresolved(threadId)).toEqual([]);
      expect((await core.getThread(threadId))!.unresolvedCommands?.find((entry) => entry.unresolvedId === clearedId)?.resolution).toBe('consumed');
      // 该命令已越过原 head（s0），且无 open unresolved 引用；处置后公开写再次
      // 触发裁剪，原命令应不再享有未决保护。当前 head 棒的项仍受规则保护。
      await core.setHold(threadId, false);
      const current = await core.getThread(threadId);
      if (!current) throw new Error('thread missing after resolution');
      expect(current.commands.some((entry) => entry.commandId === original.commandId)).toBe(true);
      const newerThanOriginal = Date.now() + 10_000;
      const terminalStress = Array.from({ length: 210 }, (_, index) => {
        const command = createCommandRecord({ threadId, text: `post-resolution-${index}` });
        command.commandId = `post-resolution-${index}`;
        command.idempotencyKey = `post-resolution-key-${index}`;
        command.status = WorkThreadCommandStatus.FAILED;
        command.createdAt = newerThanOriginal + index;
        command.updatedAt = newerThanOriginal + index;
        return command;
      });
      await store.update(threadId, (record) => {
        record.commands.push(...terminalStress);
        return record;
      });
      await core.appendCommand({ threadId, text: 'trigger post-resolution pruning' });
      const postResolution = await makeCore(root).core.getThread(threadId);
      if (!postResolution) throw new Error('thread missing after post-resolution pruning');
      expect(postResolution.commands.some((entry) => entry.commandId === original.commandId)).toBe(false);
    }), { numRuns: 2 });
  });

  it('可控事务内异步交错：commit 持有真实 Store 更新时 close 排队，最终状态为完整串行结果', async () => {
    const root = await freshRoot();
    const enteredIdentityCheck = deferred();
    const releaseIdentityCheck = deferred();
    let blockIdentity = false;
    const store = new WorkThreadStore({ rootDir: root });
    const core = new WorkThread({
      store,
      bridge: new WorkThreadRuntimeBridge(),
      identitySource: async (_agentId, sessionId) => {
        if (blockIdentity && sessionId === 's1') {
          enteredIdentityCheck.resolve();
          await releaseIdentityCheck.promise;
        }
        return 'workspace-identity';
      },
    });
    const started = await core.start({ sessionRef: { agentId: 'recovery-agent', sessionId: 's0' } });
    await appendDelivered(core, store, started.threadId, 'race payload');
    await core.beginSessionHandoff({ threadId: started.threadId, fromSessionId: 's0', seedContinuation: false });
    blockIdentity = true;
    const commit = core.commitSessionSuccession({
      threadId: started.threadId, fromSessionId: 's0', toSessionId: 's1',
      evidence: { integrity: 'missing', events: [] },
    });
    let close: Promise<WorkThreadRecord> | undefined;
    let settled: PromiseSettledResult<unknown>[];
    try {
      await Promise.race([
        enteredIdentityCheck.promise,
        commit.then(() => { throw new Error('commit finished without reaching the identity gate'); }),
      ]);
      close = core.closeThread(started.threadId);
    } finally {
      releaseIdentityCheck.resolve();
      settled = await Promise.allSettled(close ? [commit, close] : [commit]);
    }
    expect(settled).toHaveLength(2);
    expect(settled.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const final = await store.get(started.threadId);
    expect(final).toMatchObject({ status: 'closed', headSessionId: 's1', pendingSuccession: null });
    expect(final?.sessionChain.map((entry) => entry.sessionId)).toEqual(['s0', 's1']);
    expect(final?.unresolvedCommands?.filter((entry) => !entry.resolvedAt)).toHaveLength(1);
  });
});
