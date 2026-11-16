/** K20: an already-started request may finish late; no later command may bypass a new gate.
 * ADR-0047 does not promise to retract an external side effect already in flight.
 * Real Core/Store/Bridge; deferred transport is not a real Viewer consumption test.
 */
import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkThread } from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge, type WorkThreadBridgeSubmitTurnParams } from '../../src/core/workthread/bridge.js';
import { WorkThreadStore } from '../../src/core/workthread/store.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const changes = ['hold', 'close', 'cancel-next', 'begin', 'commit'] as const;
const scenarioArb = fc.record({ change: fc.constantFrom(...changes), count: fc.integer({ min: 2, max: 5 }) });

describe('WorkThread in-flight delivery properties', () => {
  it('M4-K20-head/cancel: rechecks the remaining commands after a gate changes during transport', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(fc.asyncProperty(scenarioArb, async ({ change, count }) => {
        vi.setSystemTime(1_700_000_000_000);
        const root = await mkdtemp(join(tmpdir(), 'workthread-inflight-'));
        const entered = gate();
        const release = gate();
        const attempts: WorkThreadBridgeSubmitTurnParams[] = [];
        let inFlight: Promise<unknown> | undefined;
        try {
          const store = new WorkThreadStore({ rootDir: root });
          const core = new WorkThread({ store, bridge: new WorkThreadRuntimeBridge({
            enabled: true,
            resolveRuntimeViewerId: (_agent, session) => `viewer-${session}`,
            submitTurn: async (params) => {
              attempts.push(structuredClone(params));
              if (attempts.length === 1) { entered.resolve(); await release.promise; }
              return { success: true };
            },
          }) });
          const { threadId } = await core.start({ sessionRef: { agentId: 'inflight-agent', sessionId: 's0' } });
          const commands = [];
          for (let i = 0; i < count; i++) {
            vi.advanceTimersByTime(1);
            commands.push((await core.appendCommand({ threadId, text: `work-${i}` })).command);
          }
          inFlight = core.deliverPendingCommands(threadId);
          await Promise.race([
            entered.promise,
            inFlight.then(() => { throw new Error('delivery finished without reaching the transport gate'); }),
          ]);
          if (change === 'hold') await core.setHold(threadId, true);
          if (change === 'close') await core.closeThread(threadId);
          if (change === 'cancel-next') await core.cancelCommand(threadId, commands[1].commandId);
          if (change === 'begin' || change === 'commit') {
            await core.beginSessionHandoff({ threadId, fromSessionId: 's0', seedContinuation: false });
            if (change === 'commit') await core.commitSessionSuccession({ threadId, fromSessionId: 's0', toSessionId: 's1' });
          }
          release.resolve();
          await inFlight;
          const expectedAttemptIds = change === 'cancel-next'
            ? commands.filter((_, i) => i !== 1).map((c) => c.commandId)
            : [commands[0].commandId];
          expect(attempts.map((a) => a.sourceRef)).toEqual(expectedAttemptIds);
          expect(attempts.every((a) => a.sessionId === 's0' && a.agentId === 'viewer-s0')).toBe(true);
          for (const attempt of attempts) expect(attempt.commandIdentity).toEqual({ commandId: attempt.sourceRef, threadId, headGeneration: 1 });
          let record = await new WorkThreadStore({ rootDir: root }).get(threadId);
          const status = (id: string) => record!.commands.find((c) => c.commandId === id)!.status;
          expect(status(commands[0].commandId)).toBe(change === 'close' ? 'cancelled' : 'delivered');
          for (const [index, command] of commands.entries()) {
            if (!index) continue;
            expect(status(command.commandId)).toBe(change === 'close' || (change === 'cancel-next' && index === 1)
              ? 'cancelled' : change === 'cancel-next' ? 'delivered' : 'pending');
          }
          if (change === 'commit') {
            expect(record!.headSessionId).toBe('s1');
            expect(record!.unresolvedCommands ?? []).toEqual([]); // first request was still pending at the commit point
            const offset = attempts.length;
            await core.deliverPendingCommands(threadId);
            expect(attempts.slice(offset).map((a) => a.sourceRef)).toEqual(commands.slice(1).map((c) => c.commandId));
            expect(attempts.slice(offset).every((a) => a.sessionId === 's1' && a.commandIdentity?.headGeneration === 2)).toBe(true);
            // The late acceptance is not proof of consumption: a later handoff must preserve it as unresolved.
            vi.advanceTimersByTime(1);
            await core.beginSessionHandoff({ threadId, fromSessionId: 's1', seedContinuation: false });
            const next = await core.commitSessionSuccession({ threadId, fromSessionId: 's1', toSessionId: 's2' });
            expect(next.unresolved.map((u) => u.commandId).sort()).toEqual(commands.map((c) => c.commandId).sort());
            record = await new WorkThreadStore({ rootDir: root }).get(threadId);
            expect(record!.unresolvedCommands).toEqual(next.unresolved);
          }
        } finally {
          release.resolve();
          await inFlight?.catch(() => {});
          await rm(root, { recursive: true, force: true });
        }
      }), { numRuns: 12, examples: changes.map((change) => [{ change, count: 3 }]) });
    } finally {
      vi.useRealTimers();
    }
  });
});
