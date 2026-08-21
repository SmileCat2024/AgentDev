/**
 * HandoffSeedFeature smoke test。
 *
 * 自 Claw `local-features/context-handoff-seed/test/smoke.test.ts` 移植，
 * 断言与 Claw 一致：验证 seed 注入、typed Context API 的双视图同步、
 * serialized tool message 重放与 _callIndex 推进。
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { HandoffSeedFeature } from '../index.js';

function createFeature() {
  return new HandoffSeedFeature({
    handoff: {
      packageId: 'pkg-1',
      sourceSessionId: 'session-1',
      mode: 'trim-transcript',
      seedMessages: [
        { role: 'system', content: 'Folded tool activity', turn: 1 },
        { role: 'user', content: 'Please continue the task.', turn: 2 },
        { role: 'assistant', content: 'I will continue from the trimmed transcript.', turn: 2 },
      ],
    },
  });
}

function createContextRecorder() {
  const messages: Array<{ role: string; content: string; turn?: number; toolCallId?: string; images?: any[] }> = [];
  const enrichedMessages: Array<{ role: string; content: string; turn?: number; toolCallId?: string; images?: any[] }> = [];
  const context = {
    add(msg: any): void {
      messages.push({ role: msg.role, content: msg.content, turn: msg.turn });
      // add() intentionally does NOT sync enrichedMessages — this is the
      // behavior we are testing against.
    },
    addSystemMessage(content: string, turn: number): void {
      messages.push({ role: 'system', content, turn });
      enrichedMessages.push({ role: 'system', content, turn });
    },
    addUserMessage(content: string, turn: number): void {
      messages.push({ role: 'user', content, turn });
      enrichedMessages.push({ role: 'user', content, turn });
    },
    addAssistantMessage(response: { content: string }, turn: number): void {
      messages.push({ role: 'assistant', content: response.content, turn });
      enrichedMessages.push({ role: 'assistant', content: response.content, turn });
    },
    addSerializedToolMessage(toolCallId: string, content: string, turn: number, images?: any[]): void {
      const message = { role: 'tool', content, turn, toolCallId, images };
      messages.push(message);
      enrichedMessages.push(message);
    },
  };
  return { messages, enrichedMessages, context };
}

describe('HandoffSeedFeature', () => {

  it('should inject seed messages on first call', async () => {
    const feature = createFeature();
    const { messages, context } = createContextRecorder();
    const agent = { _callIndex: 0 };

    await feature.injectHandoffSummary({
      input: 'hello',
      isFirstCall: true,
      context,
      agent,
    } as any);

    assert.equal(messages.length, 3);
  });

  it('should advance _callIndex past seed turns', async () => {
    const feature = createFeature();
    const { context } = createContextRecorder();
    const agent = { _callIndex: 0 };

    await feature.injectHandoffSummary({
      input: 'hello',
      isFirstCall: true,
      context,
      agent,
    } as any);

    // seedMessages have turns 1, 2, 2 -> injectionTurn = max(0, 1+1, 2+1, 2+1) = 3
    assert.equal(agent._callIndex, 3);
  });

  it('should inject only once (skip on subsequent calls)', async () => {
    const feature = createFeature();
    const { messages, context } = createContextRecorder();

    await feature.injectHandoffSummary({
      input: 'hello',
      isFirstCall: true,
      context,
      agent: { _callIndex: 0 },
    } as any);

    await feature.injectHandoffSummary({
      input: 'again',
      isFirstCall: false,
      context,
      agent: { _callIndex: 1 },
    } as any);

    assert.equal(messages.length, 3);
  });

  it('should sync enrichedMessages for system/user/assistant seed messages', async () => {
    const feature = createFeature();
    const { messages, enrichedMessages, context } = createContextRecorder();

    await feature.injectHandoffSummary({
      input: 'hello',
      isFirstCall: true,
      context,
      agent: { _callIndex: 0 },
    } as any);

    // All 3 seed messages are system/user/assistant — they must appear in
    // BOTH arrays, not just messages[].
    assert.equal(messages.length, 3);
    assert.equal(enrichedMessages.length, 3,
      'enrichedMessages must be in sync with messages after seed injection');
  });

  it('should route system seed messages through addSystemMessage', async () => {
    const feature = new HandoffSeedFeature({
      handoff: {
        packageId: 'pkg-sys',
        sourceSessionId: 'session-sys',
        mode: 'summary-message',
        seedMessages: [
          { role: 'system', content: 'Compact summary text', turn: 0 },
        ],
      },
    });
    const { messages, enrichedMessages, context } = createContextRecorder();

    await feature.injectHandoffSummary({
      input: 'continue',
      isFirstCall: true,
      context,
      agent: { _callIndex: 0 },
    } as any);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].turn, 0);
    assert.equal(enrichedMessages.length, 1,
      'system seed must reach enrichedMessages via addSystemMessage');
  });

  it('should route user seed messages through addUserMessage with images', async () => {
    const feature = new HandoffSeedFeature({
      handoff: {
        packageId: 'pkg-user',
        sourceSessionId: 'session-user',
        mode: 'trim-transcript',
        seedMessages: [
          { role: 'user', content: 'Check this screenshot', turn: 1, images: [{ source: 'img.png' }] },
        ],
      },
    });
    const { messages, enrichedMessages, context } = createContextRecorder();

    await feature.injectHandoffSummary({
      input: 'ok',
      isFirstCall: true,
      context,
      agent: { _callIndex: 0 },
    } as any);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(enrichedMessages.length, 1,
      'user seed must reach enrichedMessages via addUserMessage');
  });

  it('should route assistant seed messages through addAssistantMessage', async () => {
    const feature = new HandoffSeedFeature({
      handoff: {
        packageId: 'pkg-asst',
        sourceSessionId: 'session-asst',
        mode: 'trim-transcript',
        seedMessages: [
          { role: 'assistant', content: 'I will help with that.', turn: 1, reasoning: 'thinking...' },
        ],
      },
    });
    const { messages, enrichedMessages, context } = createContextRecorder();

    await feature.injectHandoffSummary({
      input: 'thanks',
      isFirstCall: true,
      context,
      agent: { _callIndex: 0 },
    } as any);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(enrichedMessages.length, 1,
      'assistant seed must reach enrichedMessages via addAssistantMessage');
  });

  it('should replay tool seed messages with images into both context views', async () => {
    const images = [{ path: 'managed/hash.png', mediaType: 'image/png', source: 'original.png' }];
    const content = '{"success":true,"result":"done"}';
    const feature = new HandoffSeedFeature({
      handoff: {
        packageId: 'pkg-tool',
        sourceSessionId: 'session-tool',
        mode: 'trim-transcript',
        seedMessages: [
          { role: 'tool', content, turn: 1, toolCallId: 'tc-1', images },
        ],
      },
    });
    const { messages, enrichedMessages, context } = createContextRecorder();

    await feature.injectHandoffSummary({
      input: 'ok',
      isFirstCall: true,
      context,
      agent: { _callIndex: 0 },
    } as any);

    assert.equal(messages.length, 1);
    assert.equal(enrichedMessages.length, 1);
    assert.deepEqual(messages[0], {
      role: 'tool', content, turn: 1, toolCallId: 'tc-1', images,
    });
    assert.deepEqual(enrichedMessages[0], messages[0]);
  });

  it('should handle mixed-role seed messages with correct enriched sync', async () => {
    const feature = new HandoffSeedFeature({
      handoff: {
        packageId: 'pkg-mixed',
        sourceSessionId: 'session-mixed',
        mode: 'trim-transcript',
        seedMessages: [
          { role: 'system', content: 'Context from previous session', turn: 0 },
          { role: 'user', content: 'Fix the bug in auth.ts', turn: 1 },
          { role: 'assistant', content: 'I found the issue.', turn: 1 },
          { role: 'tool', content: '{"success":true}', turn: 1, toolCallId: 'tc-1' },
          { role: 'user', content: 'Great, please apply the fix.', turn: 2 },
        ],
      },
    });
    const { messages, enrichedMessages, context } = createContextRecorder();

    await feature.injectHandoffSummary({
      input: 'continue',
      isFirstCall: true,
      context,
      agent: { _callIndex: 0 },
    } as any);

    // 5 messages total
    assert.equal(messages.length, 5);
    assert.equal(enrichedMessages.length, 5,
      'all replayed messages, including tool results, should reach enrichedMessages');
  });
});
