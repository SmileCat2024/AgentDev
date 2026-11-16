/**
 * WorkThread 基于模型的状态机性质测试。
 *
 * 参考模型只表达调用方可观察的产品语义，不调用 core 的 transition/helper；
 * fast-check 生成可达操作序列，真实 WorkThread 与模型逐步执行并比较。
 * 这不是与旧实现做差分，而是检查状态、命令和拒绝边界是否满足独立契约。
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDOFF_STALE_MS,
  WorkThread,
} from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge } from '../../src/core/workthread/bridge.js';
import {
  WorkThreadCommandStatus,
  type WorkThreadCommand,
} from '../../src/core/workthread/inbox.js';
import { WorkThreadStore, type WorkThreadRecord } from '../../src/core/workthread/store.js';

const THREAD_AGENT = 'model-agent';
const ROOT_SESSION = 's0';
const SESSION_POOL = ['s0', 's1', 's2', 's3', 'wrong'] as const;
const SLOT_POOL = [0, 1, 2, 3] as const;

type DeliveryMode = 'success' | 'retryable' | 'fatal';

type Operation =
  | { kind: 'append'; slot: number; text: string }
  | { kind: 'cancel'; slot: number }
  | { kind: 'deliver' }
  | { kind: 'delivery-mode'; mode: DeliveryMode }
  | { kind: 'hold'; held: boolean }
  | { kind: 'begin'; from: string; reason: string }
  | { kind: 'fail'; stage: string }
  | { kind: 'advance'; from: string; to: string; endKind: string }
  | { kind: 'close' }
  | { kind: 'tick'; delta: number }
  | { kind: 'reload' };

type ModelCommand = {
  id: string;
  key: string;
  text: string;
  status: WorkThreadCommandStatus;
  attempts: number;
  lastReason: string | null;
};

type ModelState = {
  status: 'open' | 'rotating' | 'rotation_failed' | 'closed';
  headSessionId: string;
  chain: Array<{ sessionId: string; role: 'head' | 'predecessor'; endKind: string | null; successorSessionId: string | null }>;
  pendingSuccession: { fromSessionId: string; reason: string; stage: string; startedAt: number } | null;
  hold: boolean;
  commands: ModelCommand[];
  latestBySlot: Map<number, string>;
};

const textArb = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 })
  .filter((text) => text.trim().length > 0);
const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  textArb.map((text) => ({ kind: 'append' as const, slot: SLOT_POOL[0], text })),
  fc.record({ slot: fc.constantFrom(...SLOT_POOL), text: textArb })
    .map(({ slot, text }) => ({ kind: 'append' as const, slot, text })),
  fc.constantFrom(...SLOT_POOL).map((slot) => ({ kind: 'cancel' as const, slot })),
  fc.constant({ kind: 'deliver' as const }),
  fc.constantFrom<DeliveryMode>('success', 'retryable', 'fatal')
    .map((mode) => ({ kind: 'delivery-mode' as const, mode })),
  fc.boolean().map((held) => ({ kind: 'hold' as const, held })),
  fc.record({
    from: fc.constantFrom(...SESSION_POOL),
    reason: fc.constantFrom('manual', 'trim', 'context_guard'),
  }).map(({ from, reason }) => ({ kind: 'begin' as const, from, reason })),
  fc.constantFrom('started', 'advance_head', 'compact_or_successor')
    .map((stage) => ({ kind: 'fail' as const, stage })),
  fc.record({
    from: fc.constantFrom(...SESSION_POOL),
    to: fc.constantFrom(...SESSION_POOL),
    endKind: fc.constantFrom('manual', 'trim'),
  }).map(({ from, to, endKind }) => ({ kind: 'advance' as const, from, to, endKind })),
  fc.constant({ kind: 'close' as const }),
  fc.integer({ min: 0, max: HANDOFF_STALE_MS * 2 })
    .map((delta) => ({ kind: 'tick' as const, delta })),
  fc.constant({ kind: 'reload' as const }),
);

function makeModel(): ModelState {
  return {
    status: 'open',
    headSessionId: ROOT_SESSION,
    chain: [{ sessionId: ROOT_SESSION, role: 'head', endKind: null, successorSessionId: null }],
    pendingSuccession: null,
    hold: false,
    commands: [],
    latestBySlot: new Map(),
  };
}

function commandKey(slot: number): string {
  return `model-slot-${slot}`;
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

function commandSnapshot(command: ModelCommand | WorkThreadCommand) {
  return {
    id: 'id' in command ? command.id : 'id',
    key: command.key ?? command.idempotencyKey,
    text: command.text,
    status: command.status,
    attempts: command.attempts,
    lastReason: command.lastReason ?? null,
  };
}

function modelCommandById(model: ModelState, id: string | undefined): ModelCommand | null {
  return model.commands.find((command) => command.id === id) || null;
}

function normalizeRecord(record: WorkThreadRecord | null, modelIds: Map<string, string>) {
  if (!record) return null;
  return {
    status: record.status,
    headSessionId: record.headSessionId,
    pendingSuccession: record.pendingSuccession
      ? {
        fromSessionId: record.pendingSuccession.fromSessionId,
        reason: record.pendingSuccession.reason,
        stage: record.pendingSuccession.stage,
      }
      : null,
    hold: record.hold,
    chain: record.sessionChain.map((entry) => ({
      sessionId: entry.sessionId,
      role: entry.role,
      endKind: entry.endKind,
      successorSessionId: entry.successorSessionId,
    })),
    commands: record.commands.map((command) => ({
      id: modelIds.get(command.commandId) || `unknown-${command.commandId}`,
      key: command.idempotencyKey,
      text: command.text,
      status: command.status,
      attempts: command.attempts,
      lastReason: command.lastReason,
    })),
  };
}

function modelSnapshot(model: ModelState) {
  return {
    status: model.status,
    headSessionId: model.headSessionId,
    pendingSuccession: model.pendingSuccession
      ? {
        fromSessionId: model.pendingSuccession.fromSessionId,
        reason: model.pendingSuccession.reason,
        stage: model.pendingSuccession.stage,
      }
      : null,
    hold: model.hold,
    chain: model.chain,
    commands: model.commands.map(commandSnapshot),
  };
}

function assertEquivalent(model: ModelState, record: WorkThreadRecord | null, modelIds: Map<string, string>) {
  expect(normalizeRecord(record, modelIds)).toEqual(modelSnapshot(model));
}

function applyAppend(model: ModelState, slot: number, text: string): ModelCommand {
  const key = commandKey(slot);
  const active = model.commands.find((command) =>
    command.key === key
    && (command.status === WorkThreadCommandStatus.PENDING || command.status === WorkThreadCommandStatus.DELIVERED));
  if (active) return active;

  const command: ModelCommand = {
    id: `command-${model.commands.length}`,
    key,
    text,
    status: WorkThreadCommandStatus.PENDING,
    attempts: 0,
    lastReason: null,
  };
  model.commands.push(command);
  model.latestBySlot.set(slot, command.id);
  return command;
}

function applyDelivery(model: ModelState, mode: DeliveryMode): void {
  if (model.status === 'closed' || model.hold) return;
  if (model.pendingSuccession) {
    if (Date.now() - model.pendingSuccession.startedAt < HANDOFF_STALE_MS) return;
    model.pendingSuccession = null;
    if (model.status === 'rotating') model.status = 'open';
  }

  const pending = model.commands.filter((command) => command.status === WorkThreadCommandStatus.PENDING);
  if (mode === 'retryable') return;
  for (const command of pending) {
    command.attempts += 1;
    if (mode === 'success') {
      command.status = WorkThreadCommandStatus.DELIVERED;
      command.lastReason = null;
    } else {
      command.status = WorkThreadCommandStatus.FAILED;
      command.lastReason = 'fatal';
    }
  }
}

function applyModel(model: ModelState, operation: Operation, deliveryMode: { value: DeliveryMode }): string | null {
  switch (operation.kind) {
    case 'append': {
      if (model.status === 'closed') return 'thread_closed';
      applyAppend(model, operation.slot, operation.text);
      return null;
    }
    case 'cancel': {
      const id = model.latestBySlot.get(operation.slot);
      const command = modelCommandById(model, id);
      if (command && (command.status === WorkThreadCommandStatus.PENDING || command.status === WorkThreadCommandStatus.DELIVERED)) {
        command.status = WorkThreadCommandStatus.CANCELLED;
        command.lastReason = 'cancelled_by_interrupt';
      }
      return null;
    }
    case 'deliver':
      applyDelivery(model, deliveryMode.value);
      return null;
    case 'delivery-mode':
      deliveryMode.value = operation.mode;
      return null;
    case 'hold':
      if (model.status === 'closed') return 'thread_closed';
      model.hold = operation.held;
      return null;
    case 'begin':
      if (model.status === 'closed') return 'thread_closed';
      if (model.hold) return 'thread_held';
      if (model.status === 'rotating' && model.pendingSuccession
        && Date.now() - model.pendingSuccession.startedAt < HANDOFF_STALE_MS) return 'handoff_in_progress';
      if (model.headSessionId !== operation.from) return 'head_mismatch';
      model.status = 'rotating';
      model.pendingSuccession = {
        fromSessionId: operation.from,
        reason: operation.reason,
        stage: 'started',
        startedAt: Date.now(),
      };
      return null;
    case 'fail':
      if (model.status === 'closed' || !model.pendingSuccession) return null;
      model.status = 'rotation_failed';
      model.pendingSuccession.stage = operation.stage;
      return null;
    case 'advance': {
      if (model.status === 'closed') return 'thread_closed';
      if (model.hold) return 'thread_held';
      if (!model.pendingSuccession) return 'handoff_not_started';
      if (model.headSessionId !== operation.from) return 'head_mismatch';
      if (model.headSessionId === operation.to) return 'already_head';
      if (model.chain.some((entry) => entry.sessionId === operation.to)) return 'duplicate_session';
      const current = model.chain.find((entry) => entry.sessionId === model.headSessionId);
      if (current) {
        current.role = 'predecessor';
        current.endKind = operation.endKind;
        current.successorSessionId = operation.to;
      }
      model.chain.push({ sessionId: operation.to, role: 'head', endKind: null, successorSessionId: null });
      model.headSessionId = operation.to;
      model.pendingSuccession = null;
      model.status = 'open';
      return null;
    }
    case 'close':
      if (model.status === 'closed') return null;
      model.status = 'closed';
      for (const command of model.commands) {
        if (command.status === WorkThreadCommandStatus.PENDING) {
          command.status = WorkThreadCommandStatus.CANCELLED;
          command.lastReason = 'thread_closed';
        }
      }
      return null;
    case 'tick':
      // 时钟由真实执行器统一推进；模型只观察推进后的 Date.now()。
      return null;
    case 'reload':
      return null;
  }
}

function makeBridge(mode: { value: DeliveryMode }): WorkThreadRuntimeBridge {
  return new WorkThreadRuntimeBridge({
    enabled: true,
    resolveRuntimeViewerId: () => 'model-viewer',
    submitTurn: async () => {
      if (mode.value === 'success') return { success: true };
      if (mode.value === 'retryable') throw new Error('temporary delivery failure');
      const error = Object.assign(new Error('fatal delivery failure'), {
        name: 'UserTurnDeliveryError',
        code: 'fatal',
        retryable: false,
      });
      throw error;
    },
  });
}

async function applyReal(
  thread: WorkThread,
  threadId: string,
  operation: Operation,
  deliveryMode: { value: DeliveryMode },
  commandIds: Map<number, string>,
): Promise<string | null> {
  try {
    switch (operation.kind) {
      case 'append': {
        const result = await thread.appendCommand({
          threadId,
          text: operation.text,
          idempotencyKey: commandKey(operation.slot),
        });
        commandIds.set(operation.slot, result.command.commandId);
        return null;
      }
      case 'cancel': {
        const commandId = commandIds.get(operation.slot);
        if (commandId) await thread.cancelCommand(threadId, commandId);
        return null;
      }
      case 'deliver':
        await thread.deliverPendingCommands(threadId);
        return null;
      case 'delivery-mode':
        deliveryMode.value = operation.mode;
        return null;
      case 'hold':
        await thread.setHold(threadId, operation.held);
        return null;
      case 'begin':
        await thread.beginSessionHandoff({ threadId, fromSessionId: operation.from, reason: operation.reason, seedContinuation: false });
        return null;
      case 'fail':
        await thread.failSessionHandoff(threadId, { stage: operation.stage });
        return null;
      case 'advance':
        await thread.advanceHead({ threadId, fromSessionId: operation.from, toSessionId: operation.to, endKind: operation.endKind });
        return null;
      case 'close':
        await thread.closeThread(threadId);
        return null;
      case 'tick':
        vi.advanceTimersByTime(operation.delta);
        return null;
      case 'reload':
        return null;
    }
  } catch (error) {
    return errorCode(error);
  }
}

describe('WorkThread model-based state machine properties', () => {
  it('keeps the real thread aligned with an independent model across reachable operation sequences', async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(operationArb, { minLength: 1, maxLength: 35 }), async (operations) => {
          vi.setSystemTime(1_700_000_000_000);
          const root = await mkdtemp(join(tmpdir(), 'agentdev-workthread-model-'));
          try {
            const deliveryMode = { value: 'success' as DeliveryMode };
            let thread = new WorkThread({ store: new WorkThreadStore({ rootDir: root }), bridge: makeBridge(deliveryMode) });
            const started = await thread.start({ sessionRef: { agentId: THREAD_AGENT, sessionId: ROOT_SESSION } });
            const threadId = started.threadId;
            const model = makeModel();
            const commandIds = new Map<number, string>();
            const modelIds = new Map<string, string>();

            for (const [stepIndex, operation] of operations.entries()) {
              const expectedError = applyModel(model, operation, deliveryMode);
              const actualError = await applyReal(thread, threadId, operation, deliveryMode, commandIds);

              if (operation.kind === 'append' && !actualError) {
                const record = await thread.getThread(threadId);
                const actualId = commandIds.get(operation.slot);
                const actualCommand = record?.commands.find((command) => command.commandId === actualId);
                const expectedCommand = model.latestBySlot.get(operation.slot);
                if (actualCommand && expectedCommand) modelIds.set(actualCommand.commandId, expectedCommand);
              }

              expect(actualError, `step ${stepIndex}: ${JSON.stringify(operation)}`).toBe(expectedError);
              const record = await thread.getThread(threadId);
              assertEquivalent(model, record, modelIds);

              if (operation.kind === 'reload') {
                thread = new WorkThread({ store: new WorkThreadStore({ rootDir: root }), bridge: makeBridge(deliveryMode) });
                const reloaded = await thread.getThread(threadId);
                assertEquivalent(model, reloaded, modelIds);
              }
            }
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }),
        { numRuns: 40, endOnFailure: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
