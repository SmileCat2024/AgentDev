/**
 * WorkThread Inbox 性质测试：用输入域探索命令身份与投递终态。
 *
 * 这些性质不复制 core 的分支实现，而是从用户可感知的命令生命周期定义
 * 独立的模型预期：活动命令重复提交不得制造第二次工作；终态命令可以
 * 代表新的执行意图；暂时不可投递时命令仍留在 Inbox，确定性拒绝才收口。
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkThread } from '../../src/core/workthread/core.js';
import { WorkThreadRuntimeBridge } from '../../src/core/workthread/bridge.js';
import {
  appendCommand,
  createCommandRecord,
  WorkThreadCommandStatus,
} from '../../src/core/workthread/inbox.js';
import { WorkThreadStore } from '../../src/core/workthread/store.js';

const textArb = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 })
  .filter((text) => text.trim().length > 0);
const keyArb = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 20 })
  .filter((key) => key.trim().length > 0 && !key.startsWith('reissue-'));
const activeStatusArb = fc.constantFrom(
  WorkThreadCommandStatus.PENDING,
  WorkThreadCommandStatus.DELIVERED,
);
const terminalStatusArb = fc.constantFrom(
  WorkThreadCommandStatus.FAILED,
  WorkThreadCommandStatus.CANCELLED,
);

describe('WorkThread Inbox properties', () => {
  it('deduplicates a repeated active submission without changing the first payload', () => {
    fc.assert(
      fc.property(textArb, textArb, keyArb, activeStatusArb, (firstText, repeatedText, key, status) => {
        const record = { commands: [] as ReturnType<typeof createCommandRecord>[] };
        const first = createCommandRecord({ threadId: 'wt-property', text: firstText, idempotencyKey: key });
        first.status = status;
        appendCommand(record, first);

        const repeated = createCommandRecord({ threadId: 'wt-property', text: repeatedText, idempotencyKey: key });
        const result = appendCommand(record, repeated);

        expect(result.duplicate).toBe(true);
        expect(result.command.commandId).toBe(first.commandId);
        expect(result.command.text).toBe(firstText);
        expect(record.commands).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });

  it('treats reuse after a terminal command as a new execution intent', () => {
    fc.assert(
      fc.property(textArb, textArb, keyArb, terminalStatusArb, (firstText, secondText, key, status) => {
        const record = { commands: [] as ReturnType<typeof createCommandRecord>[] };
        const first = createCommandRecord({ threadId: 'wt-property', text: firstText, idempotencyKey: key });
        first.status = status;
        appendCommand(record, first);

        const second = createCommandRecord({ threadId: 'wt-property', text: secondText, idempotencyKey: key });
        const result = appendCommand(record, second);

        expect(result.duplicate).toBe(false);
        expect(result.command.commandId).toBe(second.commandId);
        expect(record.commands).toHaveLength(2);
        expect(record.commands[0].status).toBe(status);
        expect(record.commands[1].status).toBe(WorkThreadCommandStatus.PENDING);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps a retryable delivery pending, then delivers the same command when recovery succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, async (text) => {
        const root = await mkdtemp(join(tmpdir(), 'agentdev-workthread-property-'));
        try {
          let submitAttempts = 0;
          const bridge = new WorkThreadRuntimeBridge({
            enabled: true,
            resolveRuntimeViewerId: () => 'viewer-property',
            submitTurn: async () => {
              submitAttempts += 1;
              if (submitAttempts === 1) throw new Error('runtime temporarily unavailable');
              return { success: true };
            },
          });
          const store = new WorkThreadStore({ rootDir: root });
          const thread = new WorkThread({ store, bridge });
          const started = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'property-head' } });
          const { command } = await thread.appendCommand({ threadId: started.threadId, text });

          const first = await thread.deliverPendingCommands(started.threadId);
          const afterRetryable = (await thread.getThread(started.threadId))!.commands[0];
          expect(first.delivered).toBe(0);
          expect(first.results[0]).toMatchObject({ accepted: false, retryable: true });
          expect(afterRetryable.status).toBe(WorkThreadCommandStatus.PENDING);
          expect(afterRetryable.commandId).toBe(command.commandId);

          const second = await thread.deliverPendingCommands(started.threadId);
          const afterRecovery = (await thread.getThread(started.threadId))!.commands[0];
          expect(second.delivered).toBe(1);
          expect(afterRecovery.status).toBe(WorkThreadCommandStatus.DELIVERED);
          expect(afterRecovery.commandId).toBe(command.commandId);
          expect(submitAttempts).toBe(2);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 30 },
    );
  });

  it('closes a command as failed for a deterministic delivery rejection', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, fc.string({ unit: 'grapheme', minLength: 1, maxLength: 20 }), async (text, reason) => {
        const root = await mkdtemp(join(tmpdir(), 'agentdev-workthread-property-'));
        try {
          const bridge = new WorkThreadRuntimeBridge({
            enabled: true,
            resolveRuntimeViewerId: () => 'viewer-property',
            submitTurn: async () => {
              const error = Object.assign(new Error(reason), {
                name: 'UserTurnDeliveryError',
                code: 'invalid_input',
                retryable: false,
              });
              throw error;
            },
          });
          const store = new WorkThreadStore({ rootDir: root });
          const thread = new WorkThread({ store, bridge });
          const started = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'property-head' } });
          await thread.appendCommand({ threadId: started.threadId, text });

          const result = await thread.deliverPendingCommands(started.threadId);
          const command = (await thread.getThread(started.threadId))!.commands[0];
          expect(result.results[0]).toMatchObject({ accepted: false, retryable: false, reason: 'invalid_input' });
          expect(command.status).toBe(WorkThreadCommandStatus.FAILED);
          expect(command.lastReason).toBe('invalid_input');
          expect(command.attempts).toBe(1);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 30 },
    );
  });

  it('cancels a pending command without allowing a second cancel to change it', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, async (text) => {
        const root = await mkdtemp(join(tmpdir(), 'agentdev-workthread-property-'));
        try {
          const store = new WorkThreadStore({ rootDir: root });
          const thread = new WorkThread({ store, bridge: new WorkThreadRuntimeBridge() });
          const started = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'property-head' } });
          const { command } = await thread.appendCommand({ threadId: started.threadId, text });

          const cancelled = await thread.cancelCommand(started.threadId, command.commandId);
          const repeated = await thread.cancelCommand(started.threadId, command.commandId);
          expect(cancelled?.status).toBe(WorkThreadCommandStatus.CANCELLED);
          expect(repeated?.status).toBe(WorkThreadCommandStatus.CANCELLED);
          expect((await thread.getThread(started.threadId))!.commands).toHaveLength(1);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 30 },
    );
  });

  it('rejects new commands after the thread is closed', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, async (text) => {
        const root = await mkdtemp(join(tmpdir(), 'agentdev-workthread-property-'));
        try {
          const store = new WorkThreadStore({ rootDir: root });
          const thread = new WorkThread({ store, bridge: new WorkThreadRuntimeBridge() });
          const started = await thread.start({ sessionRef: { agentId: 'coder', sessionId: 'property-head' } });
          await thread.closeThread(started.threadId, { reason: 'property-close' });

          await expect(thread.appendCommand({ threadId: started.threadId, text }))
            .rejects.toMatchObject({ code: 'thread_closed', status: 409 });
          const closed = await thread.getThread(started.threadId);
          expect(closed?.status).toBe('closed');
          expect(closed?.commands).toHaveLength(0);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 30 },
    );
  });
});
