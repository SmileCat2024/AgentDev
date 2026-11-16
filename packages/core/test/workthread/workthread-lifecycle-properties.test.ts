/**
 * Product-level reachable journeys (ADR-0047; M1-R3/M4-R3-VOID/M8D-UNCERTAIN-REF).
 * Each generated journey completes several handoffs; close is only tested at the end.
 * The oracle tracks accepted command identities, not the production transition table.
 * Real Core/Store/Bridge, injected runtime boundary: no claim of Viewer dedup or LLM exactly-once.
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkThread, HANDOFF_STALE_MS } from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge, type WorkThreadBridgeSubmitTurnParams } from '../../src/core/workthread/bridge.js';
import { WorkThreadStore } from '../../src/core/workthread/store.js';
import type { WorkThreadCommand, WorkThreadUnresolvedCommand } from '../../src/core/workthread/inbox.js';

const cycleArb = fc.record({
  payload: fc.integer({ min: -1000, max: 1000 }),
  automatic: fc.boolean(),
  failFirst: fc.boolean(),
  consumed: fc.boolean(),
  resolution: fc.constantFrom('consumed', 'discard', 'reissue'),
});
const journeyArb = fc.array(cycleArb, { minLength: 2, maxLength: 4 });
type Cycle = { payload: number; automatic: boolean; failFirst: boolean; consumed: boolean; resolution: 'consumed' | 'discard' | 'reissue' };

// Guaranteed boundaries complement generated combinations, rather than hoping to hit them.
const boundaries: Cycle[] = [
  { payload: 1, automatic: true, failFirst: true, consumed: false, resolution: 'reissue' },
  { payload: 2, automatic: false, failFirst: false, consumed: true, resolution: 'consumed' },
  { payload: 3, automatic: false, failFirst: true, consumed: false, resolution: 'discard' },
];

function wire(command: WorkThreadCommand, threadId: string, sessionId: string, generation: number): WorkThreadBridgeSubmitTurnParams {
  return {
    agentId: `viewer-${sessionId}`, sessionId, kind: command.kind,
    text: command.text, source: 'thread', sourceRef: command.commandId,
    ...(command.kind === 'user_message' || command.kind === 'external'
      ? { commandIdentity: { commandId: command.commandId, threadId, headGeneration: generation } } : {}),
    ...(command.images ? { images: command.images } : {}),
    ...(command.capabilityActivations ? { capabilityActivations: command.capabilityActivations } : {}),
    ...(command.metadata ? { metadata: command.metadata } : {}),
  };
}

function pending(record: { commands: WorkThreadCommand[] }) {
  // This order is the Inbox's public tie-breaking contract, not a production helper.
  return record.commands.filter((c) => c.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt || (a.commandId < b.commandId ? -1 : 1));
}

function payload(command: WorkThreadCommand | WorkThreadUnresolvedCommand) {
  return {
    text: command.text, images: command.images, metadata: command.metadata,
    capabilityActivations: command.capabilityActivations, originSourceRef: command.originSourceRef,
  };
}

describe('WorkThread reachable lifecycle properties', () => {
  it('M8D-UNCERTAIN-REF: preserves work and exact delivery identities across repeated valid handoffs', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(fc.asyncProperty(journeyArb, async (cycles) => {
        vi.setSystemTime(1_700_000_000_000);
        const root = await mkdtemp(join(tmpdir(), 'workthread-journey-'));
        try {
          const submissions: WorkThreadBridgeSubmitTurnParams[] = [];
          let retryable = false;
          const bridge = new WorkThreadRuntimeBridge({
            enabled: true,
            resolveRuntimeViewerId: (_agent, session) => `viewer-${session}`,
            submitTurn: async (params) => {
              submissions.push(structuredClone(params));
              if (retryable) throw new Error('runtime temporarily unavailable');
              return { success: true };
            },
          });
          const reopen = () => new WorkThread({ store: new WorkThreadStore({ rootDir: root }), bridge });
          let core = reopen();
          const started = await core.start({ sessionRef: { agentId: 'journey-agent', sessionId: 's0' } });
          const tid = started.threadId;
          const retained = new Map<string, WorkThreadUnresolvedCommand>();
          const consumedRefs = new Map<string, string[]>();
          let head = 's0';
          let generation = 1;
          let completedHandoffs = 0;

          for (const [index, cycle] of cycles.entries()) {
            vi.advanceTimersByTime(1);
            const first = await core.appendCommand({
              threadId: tid, text: `work-${index}-${cycle.payload}`, idempotencyKey: `work-${index}`,
              images: [`image-${index}.png`], capabilityActivations: ['plan-mode'],
              metadata: { nested: { value: cycle.payload } }, originSourceRef: `origin-${index}`,
            });
            const duplicate = await core.appendCommand({ threadId: tid, text: 'must not replace payload', idempotencyKey: `work-${index}` });
            expect(duplicate.command.commandId).toBe(first.command.commandId);
            expect(payload(duplicate.command)).toEqual(payload(first.command));

            // Positive and negative observations use the same real runtime boundary.
            await core.setHold(tid, true);
            let offset = submissions.length;
            expect(await core.deliverPendingCommands(tid)).toMatchObject({ attempted: 0, reason: 'thread_held' });
            expect(submissions.slice(offset)).toEqual([]);
            await core.setHold(tid, false);
            retryable = true;
            expect(await core.deliverPendingCommands(tid)).toMatchObject({ attempted: 1, delivered: 0 });
            expect(submissions.slice(offset)).toEqual([wire(first.command, tid, head, generation)]);
            expect((await core.getThread(tid))!.commands.find((c) => c.commandId === first.command.commandId)?.status).toBe('pending');
            retryable = false;
            offset = submissions.length;
            expect(await core.deliverPendingCommands(tid)).toMatchObject({ attempted: 1, delivered: 1 });
            expect(submissions.slice(offset)).toEqual([wire(first.command, tid, head, generation)]);

            vi.advanceTimersByTime(1);
            await core.beginSessionHandoff({ threadId: tid, fromSessionId: head, seedContinuation: cycle.automatic });
            if (cycle.failFirst) {
              await core.failSessionHandoff(tid, { stage: 'successor_ready', reason: 'injected-not-ready' });
              offset = submissions.length;
              expect(await core.deliverPendingCommands(tid)).toMatchObject({ attempted: 0, reason: 'handoff_in_progress' });
              expect(submissions.slice(offset)).toEqual([]);
              // Exact stale boundary; R3 must never announce a successful handoff to the old head.
              vi.advanceTimersByTime(HANDOFF_STALE_MS);
              const cleared = await core.deliverPendingCommands(tid);
              expect(cleared.delivered).toBe(0);
              expect(submissions.slice(offset)).toEqual([]);
              if (cycle.automatic) {
                expect(cleared.results).toEqual([expect.objectContaining({ reason: 'succession_precondition_violated', retryable: false })]);
              }
              core = reopen();
              await core.beginSessionHandoff({ threadId: tid, fromSessionId: head, seedContinuation: cycle.automatic });
            }

            vi.advanceTimersByTime(1);
            const staged = await core.appendCommand({ threadId: tid, text: `staged-${index}`, idempotencyKey: `staged-${index}` });
            offset = submissions.length;
            expect(await core.deliverPendingCommands(tid)).toMatchObject({ attempted: 0, reason: 'handoff_in_progress' });
            expect(submissions.slice(offset)).toEqual([]);
            const nextHead = `s${index + 1}`;
            const committed = await core.commitSessionSuccession({
              threadId: tid, fromSessionId: head, toSessionId: nextHead,
              evidence: {
                integrity: 'ok',
                events: [{ sessionId: head, event: { type: 'turn.started', consumedSourceRefs: [
                  ...(consumedRefs.get(head) ?? []), ...(cycle.consumed ? [first.command.commandId] : []),
                ] } }],
              },
              ...(cycle.automatic ? { composeNotice: (items: WorkThreadUnresolvedCommand[]) => ({ text: `inspect:${items.map((u) => u.commandId).join(',')}` }) } : {}),
            });
            expect([...committed.consumedCommandIds].sort()).toEqual([
              ...(consumedRefs.get(head) ?? []), ...(cycle.consumed ? [first.command.commandId] : []),
            ].sort());
            expect(committed.unresolved).toHaveLength(cycle.consumed ? 0 : 1);
            if (!cycle.consumed) {
              const item = committed.unresolved[0];
              expect(item).toMatchObject({ commandId: first.command.commandId, fromHeadSessionId: head, resolvedAt: null });
              expect(payload(item)).toEqual(payload(first.command));
              retained.set(item.unresolvedId, structuredClone(item));
            }
            expect(submissions.slice(offset)).toEqual([]); // commit itself never submits runtime input
            head = nextHead;
            generation += 1;
            completedHandoffs += 1;
            core = reopen();
            const record = await core.getThread(tid);
            if (!record) throw new Error('committed thread disappeared after reload');
            expect(record.headSessionId).toBe(head);
            expect(record.headGeneration).toBe(generation);
            expect(record.sessionChain.map((e) => e.sessionId)).toEqual(Array.from({ length: generation }, (_, n) => `s${n}`));
            expect(record.sessionChain.filter((e) => e.role === 'head')).toHaveLength(1);
            expect(record.pendingSuccession).toBeNull();
            for (const [id, snapshot] of retained) expect(record.unresolvedCommands?.find((u) => u.unresolvedId === id)).toEqual(snapshot);
            const toSend = pending(record);
            expect(toSend.some((c) => c.commandId === staged.command.commandId)).toBe(true);
            const systemInputs = toSend.filter((c) => c.kind === 'system_continuation');
            expect(systemInputs).toHaveLength(cycle.automatic ? (cycle.consumed ? 1 : 2) : 0);
            // Exact membership prevents a correct-looking snapshot from hiding a lost
            // staged input or a notice that omits the work requiring reconciliation.
            expect(toSend.filter((c) => c.kind !== 'system_continuation').map((c) => c.commandId)).toEqual([staged.command.commandId]);
            if (cycle.automatic) {
              expect(systemInputs.filter((c) => c.idempotencyKey === `succession:${tid}:s${index}`)).toHaveLength(1);
              const notices = systemInputs.filter((c) => c.idempotencyKey === `succession-notice:${tid}:${head}`);
              expect(notices).toHaveLength(cycle.consumed ? 0 : 1);
              if (!cycle.consumed) expect(notices[0].text).toBe(`inspect:${first.command.commandId}`);
            }
            offset = submissions.length;
            expect((await core.deliverPendingCommands(tid)).delivered).toBe(toSend.length);
            expect(submissions.slice(offset)).toEqual(toSend.map((c) => wire(c, tid, head, generation)));
            consumedRefs.set(head, [staged.command.commandId]);
            expect(submissions.slice(offset).some((s) => s.sourceRef === first.command.commandId)).toBe(false);
            offset = submissions.length;
            await core.deliverPendingCommands(tid);
            expect(submissions.slice(offset)).toEqual([]);

            // Each resolution kind is an explicit decision, not a missing-evidence inference.
            if (committed.unresolved.length) {
              const item = committed.unresolved[0];
              const resolution = cycle.resolution;
              vi.advanceTimersByTime(1);
              const resolved = await core.resolveUnresolved({ threadId: tid, unresolvedId: item.unresolvedId, resolution });
              const repeated = await core.resolveUnresolved({ threadId: tid, unresolvedId: item.unresolvedId, resolution });
              expect(repeated.command?.commandId ?? null).toBe(resolved.command?.commandId ?? null);
              retained.set(item.unresolvedId, structuredClone(resolved.record.unresolvedCommands!.find((u) => u.unresolvedId === item.unresolvedId)!));
              offset = submissions.length;
              await core.deliverPendingCommands(tid);
              if (resolution === 'reissue') {
                expect(resolved.command).not.toBeNull();
                expect(resolved.command!.commandId).not.toBe(first.command.commandId);
                expect(resolved.command!.metadata).toEqual({ ...first.command.metadata, reissueOf: first.command.commandId });
                expect(submissions.slice(offset)).toEqual([wire(resolved.command!, tid, head, generation)]);
                consumedRefs.get(head)!.push(resolved.command!.commandId);
              } else {
                expect(resolved.command).toBeNull();
                expect(submissions.slice(offset)).toEqual([]);
              }
            }
            // Time windows do not overlap with the next generation's newly delivered work.
            vi.advanceTimersByTime(1);
          }
          expect(completedHandoffs).toBe(cycles.length); // rejects/vacuous journeys cannot count as exploration
          const final = await core.getThread(tid);
          await core.closeThread(tid);
          const closed = await core.getThread(tid);
          if (!final || !closed) throw new Error('thread disappeared during close');
          expect(closed.headSessionId).toBe(final.headSessionId);
          expect(closed.unresolvedCommands).toEqual(final.unresolvedCommands);
          const offset = submissions.length;
          expect(await core.deliverPendingCommands(tid)).toMatchObject({ attempted: 0, reason: 'thread_closed' });
          expect(submissions.slice(offset)).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }), { numRuns: 12, examples: [[boundaries]] });
    } finally {
      vi.useRealTimers();
    }
  });
});
