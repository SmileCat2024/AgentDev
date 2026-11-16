/**
 * WorkThread 接续性质测试：验证退役命令分类与 unresolved 处置的状态机不变量。
 *
 * 这些性质把“已消费 / 无法判定 / 不属于退役棒候选集”作为互斥分区，
 * 再验证消费证据增加时结论只会向已消费推进；处置接口则验证同一决定
 * 可重复、不同决定会冲突，以及 reissue 不会制造第二条实际命令。
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkThread } from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge } from '../../src/core/workthread/bridge.js';
import {
  classifyRetiredCommands,
  createCommandRecord,
  WorkThreadCommandStatus,
  WorkThreadCommandKind,
  WORKTHREAD_SUCCESSION_REASONS,
  type SuccessionEvidence,
  type WorkThreadCommand,
} from '../../src/core/workthread/inbox.js';
import { WorkThreadStore } from '../../src/core/workthread/store.js';

const resolutionValues = ['consumed', 'reissue', 'discard'] as const;
type Resolution = (typeof resolutionValues)[number];

type CommandSpec = {
  status: WorkThreadCommand['status'];
  kind: string;
  deliveredAt: number | null;
};

const commandSpecArb: fc.Arbitrary<CommandSpec> = fc.record({
  status: fc.constantFrom(
    WorkThreadCommandStatus.PENDING,
    WorkThreadCommandStatus.DELIVERED,
    WorkThreadCommandStatus.FAILED,
    WorkThreadCommandStatus.CANCELLED,
  ),
  kind: fc.constantFrom(
    WorkThreadCommandKind.USER_MESSAGE,
    WorkThreadCommandKind.EXTERNAL,
    WorkThreadCommandKind.SYSTEM_CONTINUATION,
  ),
  deliveredAt: fc.option(fc.integer({ min: 0, max: 3_000 }), { nil: null }),
});

const textArb = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 })
  .filter((text) => text.trim().length > 0);

function makeCommands(specs: CommandSpec[]): WorkThreadCommand[] {
  return specs.map((spec, index) => {
    const command = createCommandRecord({
      threadId: 'wt-property',
      kind: spec.kind,
      text: `command-${index}`,
    });
    command.commandId = `cmd-${index}`;
    command.status = spec.status;
    command.deliveredAt = spec.deliveredAt;
    command.createdAt = index;
    command.updatedAt = index;
    return command;
  });
}

function evidenceWithRefs(refs: string[], integrity: SuccessionEvidence['integrity'] = 'ok'): SuccessionEvidence {
  if (integrity !== 'ok') return { integrity, events: [] };
  return {
    integrity,
    // 即使没有引用也保留该退役棒的事件，避免把“没有事件”与“有事件但没有该命令引用”混在一起。
    events: [
      {
        sessionId: 's-retired',
        event: {
          type: 'turn.started',
          ...(refs.length > 0 ? { consumedSourceRefs: refs } : {}),
        },
      },
    ],
  };
}

function classifyInput(specs: CommandSpec[], evidence: SuccessionEvidence) {
  const commands = makeCommands(specs);
  const result = classifyRetiredCommands(
    {
      commands,
      sessionChain: [{ sessionId: 's-retired', startedAt: 1_000, endedAt: 2_000 }],
    },
    's-retired',
    evidence,
  );
  return { commands, result };
}

function ids(commands: Array<{ commandId: string }>): string[] {
  return commands.map((command) => command.commandId).sort();
}

async function makeUnresolvedThread(root: string, text: string) {
  const store = new WorkThreadStore({ rootDir: root });
  const thread = new WorkThread({ store, bridge: new WorkThreadRuntimeBridge() });
  const started = await thread.start({ sessionRef: { agentId: 'property-agent', sessionId: 's-property' } });
  const appended = await thread.appendCommand({ threadId: started.threadId, text });

  await store.update(started.threadId, (draft) => {
    const command = (draft.commands || []).find((entry) => entry.commandId === appended.command.commandId);
    if (!command) throw new Error('property command was not persisted');
    command.status = WorkThreadCommandStatus.DELIVERED;
    command.deliveredAt = Date.now();
    command.updatedAt = command.deliveredAt;
    return draft;
  });

  await thread.beginSessionHandoff({
    threadId: started.threadId,
    fromSessionId: 's-property',
    seedContinuation: false,
  });
  const committed = await thread.commitSessionSuccession({
    threadId: started.threadId,
    fromSessionId: 's-property',
    toSessionId: 's-successor',
    evidence: { integrity: 'missing', events: [] },
  });
  if (committed.unresolved.length !== 1) throw new Error('property fixture did not create one unresolved command');
  return { thread, threadId: started.threadId, unresolved: committed.unresolved[0] };
}

describe('WorkThread succession properties', () => {
  it('partitions every delivered command without overlap or silent loss', () => {
    fc.assert(
      fc.property(fc.array(commandSpecArb, { maxLength: 30 }), fc.constantFrom('ok', 'missing', 'corrupt') as fc.Arbitrary<SuccessionEvidence['integrity']>, (specs, integrity) => {
        const { commands, result } = classifyInput(specs, evidenceWithRefs([], integrity));
        const candidateIds = commands
          .filter((command) => command.status === WorkThreadCommandStatus.DELIVERED
            && command.kind !== WorkThreadCommandKind.SYSTEM_CONTINUATION
            && Number(command.deliveredAt) >= 1_000
            && Number(command.deliveredAt) <= 2_000)
          .map((command) => command.commandId);
        const unattributableIds = commands
          .filter((command) => command.status === WorkThreadCommandStatus.DELIVERED
            && command.kind !== WorkThreadCommandKind.SYSTEM_CONTINUATION
            && !Number(command.deliveredAt))
          .map((command) => command.commandId);
        const expectedUnresolved = [...candidateIds, ...unattributableIds].sort();

        const consumedIds = ids(result.consumedCommandIds.map((commandId) => ({ commandId })));
        const unresolvedIds = ids(result.undecidable.map(({ command }) => command));
        expect(new Set(consumedIds).size).toBe(consumedIds.length);
        expect(new Set(unresolvedIds).size).toBe(unresolvedIds.length);
        expect(consumedIds.filter((commandId) => unresolvedIds.includes(commandId))).toEqual([]);
        expect([...consumedIds, ...unresolvedIds].sort()).toEqual(expectedUnresolved);
        expect(consumedIds).toEqual([]);
        expect(unresolvedIds).toEqual(expectedUnresolved);

        const expectedCandidateReason = integrity === 'ok'
          ? WORKTHREAD_SUCCESSION_REASONS.NO_POSITIVE_REFERENCE
          : integrity === 'corrupt'
            ? WORKTHREAD_SUCCESSION_REASONS.EVIDENCE_CORRUPT
            : WORKTHREAD_SUCCESSION_REASONS.EVIDENCE_MISSING;
        expect(result.undecidable
          .filter(({ command }) => candidateIds.includes(command.commandId))
          .every(({ reason }) => reason === expectedCandidateReason)).toBe(true);
        expect(result.undecidable
          .filter(({ command }) => unattributableIds.includes(command.commandId))
          .every(({ reason }) => reason === WORKTHREAD_SUCCESSION_REASONS.UNATTRIBUTABLE)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('does not let unrelated evidence references claim a delivered command', () => {
    const unrelatedRefArb = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 20 })
      .filter((ref) => !ref.startsWith('cmd-'));
    fc.assert(
      fc.property(fc.array(commandSpecArb, { maxLength: 30 }), fc.array(unrelatedRefArb, { maxLength: 20 }), (specs, unrelatedRefs) => {
        const { commands, result } = classifyInput(specs, evidenceWithRefs(unrelatedRefs));
        const candidateIds = commands
          .filter((command) => command.status === WorkThreadCommandStatus.DELIVERED
            && command.kind !== WorkThreadCommandKind.SYSTEM_CONTINUATION
            && Number(command.deliveredAt) >= 1_000
            && Number(command.deliveredAt) <= 2_000)
          .map((command) => command.commandId);
        const unattributableIds = commands
          .filter((command) => command.status === WorkThreadCommandStatus.DELIVERED
            && command.kind !== WorkThreadCommandKind.SYSTEM_CONTINUATION
            && !Number(command.deliveredAt))
          .map((command) => command.commandId);
        expect(result.consumedCommandIds).toEqual([]);
        expect(ids(result.undecidable.map(({ command }) => command))).toEqual(
          [...candidateIds, ...unattributableIds].sort(),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('makes reliable references monotonically upgrade candidates, never downgrade them', () => {
    fc.assert(
      fc.property(fc.array(commandSpecArb, { maxLength: 30 }), (specs) => {
        const commands = makeCommands(specs);
        const candidateIds = commands
          .filter((command) => command.status === WorkThreadCommandStatus.DELIVERED
            && command.kind !== WorkThreadCommandKind.SYSTEM_CONTINUATION
            && Number(command.deliveredAt) >= 1_000
            && Number(command.deliveredAt) <= 2_000)
          .map((command) => command.commandId);
        const unattributableIds = commands
          .filter((command) => command.status === WorkThreadCommandStatus.DELIVERED
            && command.kind !== WorkThreadCommandKind.SYSTEM_CONTINUATION
            && !Number(command.deliveredAt))
          .map((command) => command.commandId);
        const record = {
          commands,
          sessionChain: [{ sessionId: 's-retired', startedAt: 1_000, endedAt: 2_000 }],
        };
        const withoutRefs = classifyRetiredCommands(record, 's-retired', evidenceWithRefs([]));
        const withAllRefs = classifyRetiredCommands(record, 's-retired', evidenceWithRefs(candidateIds));

        expect(ids(withoutRefs.consumedCommandIds.map((commandId) => ({ commandId })))).toEqual([]);
        expect(ids(withAllRefs.consumedCommandIds.map((commandId) => ({ commandId })))).toEqual(candidateIds.sort());
        expect(ids(withoutRefs.undecidable.map(({ command }) => command))).toEqual(
          [...candidateIds, ...unattributableIds].sort(),
        );
        expect(ids(withAllRefs.undecidable.map(({ command }) => command))).toEqual(unattributableIds.sort());
      }),
      { numRuns: 100 },
    );
  });

  it('recognizes only correctly scoped consumption evidence and is invariant to event ordering, duplicates and time translation', () => {
    // Every generated command is a known eligible input by construction. The oracle
    // does not reproduce the classifier's candidate filter or timestamp arithmetic.
    const specsArb = fc.array(fc.record({ initiallySeen: fc.boolean(), laterSeen: fc.boolean() }), { minLength: 1, maxLength: 15 });
    fc.assert(fc.property(specsArb, fc.integer({ min: 1, max: 1_000_000 }), fc.constantFrom(
      'turn.started', 'turn.continued', 'turn.completed', 'turn.cancelled', 'turn.failed',
    ), (specs, start, type) => {
      const commands = specs.map((_, index) => ({
        ...createCommandRecord({ threadId: 'evidence-thread', text: `work-${index}` }),
        commandId: `cmd-${index}`, status: WorkThreadCommandStatus.DELIVERED, deliveredAt: start + index + 1,
      }));
      const known = specs.flatMap((spec, index) => spec.initiallySeen ? [`cmd-${index}`] : []);
      const extended = specs.flatMap((spec, index) => spec.initiallySeen || spec.laterSeen ? [`cmd-${index}`] : []);
      const classify = (events: SuccessionEvidence['events'], shift = 0) => classifyRetiredCommands({
        commands: commands.map((command) => ({ ...command, deliveredAt: command.deliveredAt + shift })),
        sessionChain: [{ sessionId: 'retired', startedAt: start + shift, endedAt: start + specs.length + 1 + shift }],
      }, 'retired', { integrity: 'ok', events });
      const event = (refs: string[]) => ({ sessionId: 'retired', event: { type, consumedSourceRefs: refs } });
      const noise = [
        { sessionId: 'other-session', event: { type, consumedSourceRefs: commands.map((c) => c.commandId) } },
        { sessionId: 'retired', event: { type: 'runtime.stopped', sourceRef: commands[0].commandId } },
        { sessionId: 'retired', event: { type, sourceRef: `${commands[0].commandId}-suffix` } },
      ];
      const initial = classify([event(known), ...noise]);
      expect([...initial.consumedCommandIds].sort()).toEqual([...known].sort());
      expect(ids(initial.undecidable.map((entry) => entry.command))).toEqual(
        commands.filter((command) => !known.includes(command.commandId)).map((command) => command.commandId).sort(),
      );
      const expanded = classify([event(extended), ...noise]);
      expect([...expanded.consumedCommandIds].sort()).toEqual([...extended].sort());
      const partitioned = extended.map((sourceRef) => ({ sessionId: 'retired', event: { type, sourceRef } }));
      const reordered = classify([...noise.slice().reverse(), event([]), ...partitioned.slice().reverse(), ...partitioned]);
      expect(reordered).toEqual(expanded);
      expect(classify([event(extended), ...noise], 10_000_000)).toEqual({
        consumedCommandIds: expanded.consumedCommandIds,
        undecidable: expanded.undecidable.map(({ command, reason }) => ({ command: { ...command, deliveredAt: command.deliveredAt! + 10_000_000 }, reason })),
      });
    }), { numRuns: 80 });
  });

  it('makes repeated reissue resolution return the one actual pending command', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, async (text) => {
        const root = await mkdtemp(join(tmpdir(), 'agentdev-succession-property-'));
        try {
          const { thread, threadId, unresolved } = await makeUnresolvedThread(root, text);
          const first = await thread.resolveUnresolved({
            threadId,
            unresolvedId: unresolved.unresolvedId,
            resolution: 'reissue',
            note: 'operator replay',
          });
          const second = await thread.resolveUnresolved({
            threadId,
            unresolvedId: unresolved.unresolvedId,
            resolution: 'reissue',
          });
          expect(first.command?.commandId).toBeTruthy();
          expect(second.command?.commandId).toBe(first.command?.commandId);
          expect(second.command?.status).toBe(WorkThreadCommandStatus.PENDING);
          expect(second.command?.metadata).toMatchObject({ reissueOf: unresolved.commandId });

          const record = await thread.getThread(threadId);
          expect(record?.commands.filter((command) => command.metadata?.reissueOf === unresolved.commandId)).toHaveLength(1);
          expect(record?.unresolvedCommands?.filter((entry) => !entry.resolvedAt)).toHaveLength(0);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 30 },
    );
  });

  it('keeps a resolved decision terminal: a different resolution cannot mutate it', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, fc.integer({ min: 0, max: resolutionValues.length - 1 }), async (text, firstIndex) => {
        const root = await mkdtemp(join(tmpdir(), 'agentdev-succession-property-'));
        try {
          const { thread, threadId, unresolved } = await makeUnresolvedThread(root, text);
          const firstResolution: Resolution = resolutionValues[firstIndex];
          const conflictingResolution: Resolution = resolutionValues[(firstIndex + 1) % resolutionValues.length];
          const first = await thread.resolveUnresolved({
            threadId,
            unresolvedId: unresolved.unresolvedId,
            resolution: firstResolution,
          });
          const beforeConflict = await thread.getThread(threadId);

          await expect(thread.resolveUnresolved({
            threadId,
            unresolvedId: unresolved.unresolvedId,
            resolution: conflictingResolution,
          })).rejects.toMatchObject({ code: 'unresolved_already_resolved', status: 409 });

          const afterConflict = await thread.getThread(threadId);
          expect(afterConflict?.unresolvedCommands?.[0]?.resolution).toBe(firstResolution);
          expect(afterConflict?.unresolvedCommands?.[0]?.resolvedAt).toBe(beforeConflict?.unresolvedCommands?.[0]?.resolvedAt);
          expect(afterConflict?.commands.map((command) => command.commandId)).toEqual(
            beforeConflict?.commands.map((command) => command.commandId),
          );
          if (firstResolution === 'reissue') expect(first.command?.status).toBe(WorkThreadCommandStatus.PENDING);
          else expect(first.command).toBeNull();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 30 },
    );
  });
});
