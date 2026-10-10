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

/**
 * 镜像 Context 的消息记录器：
 * - typed add* 双数组同步（messages[] / enrichedMessages[]）
 * - legacy add() 只写 messages[]（既有行为，测试对照用）
 * - enriched 条目按 push 顺序分配递增 sequence（镜像 Context.enrich）
 * - getAllEnriched() 返回浅拷贝（镜像 Context.getAllEnriched）
 */
function createContextRecorder(options: { startSequence?: number; prefill?: number } = {}) {
  const messages: Array<{ role: string; content: string; turn?: number; toolCallId?: string; images?: any[] }> = [];
  const enrichedMessages: Array<{ role: string; content: string; turn?: number; toolCallId?: string; images?: any[]; sequence: number }> = [];
  let sequence = options.startSequence ?? 0;
  for (let i = 0; i < (options.prefill ?? 0); i++) {
    messages.push({ role: 'system', content: `prefill-${i}` });
    enrichedMessages.push({ role: 'system', content: `prefill-${i}`, sequence: sequence++ });
  }
  const context = {
    add(msg: any): void {
      messages.push({ role: msg.role, content: msg.content, turn: msg.turn });
      // add() intentionally does NOT sync enrichedMessages — this is the
      // behavior we are testing against.
    },
    addSystemMessage(content: string, turn: number): void {
      messages.push({ role: 'system', content, turn });
      enrichedMessages.push({ role: 'system', content, turn, sequence: sequence++ });
    },
    addUserMessage(content: string, turn: number): void {
      messages.push({ role: 'user', content, turn });
      enrichedMessages.push({ role: 'user', content, turn, sequence: sequence++ });
    },
    addAssistantMessage(response: { content: string }, turn: number): void {
      messages.push({ role: 'assistant', content: response.content, turn });
      enrichedMessages.push({ role: 'assistant', content: response.content, turn, sequence: sequence++ });
    },
    addSerializedToolMessage(toolCallId: string, content: string, turn: number, images?: any[]): void {
      const message = { role: 'tool', content, turn, toolCallId, images };
      messages.push(message);
      enrichedMessages.push({ ...message, sequence: sequence++ });
    },
    getAllEnriched(): typeof enrichedMessages {
      return enrichedMessages.map(m => ({ ...m }));
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
    // enriched 条目携带 sequence 元数据，正文字段与 messages 侧逐字段一致
    const { sequence: _seq, ...enrichedBody } = enrichedMessages[0];
    assert.deepEqual(enrichedBody, messages[0]);
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

describe('HandoffSeedFeature captureState（注入事实回写，ADR-0024 PR-3）', () => {
  function inject(feature: HandoffSeedFeature, recorder: ReturnType<typeof createContextRecorder>) {
    return feature.injectHandoffSummary({
      input: 'hello',
      isFirstCall: true,
      context: recorder.context,
      agent: { _callIndex: 0 },
    } as any);
  }

  it('未注入时快照保持旧最小形态 { injected: false }', () => {
    const feature = createFeature();
    assert.deepEqual(feature.captureState(), { injected: false });
  });

  it('注入后快照回写 packageId / seedCount / seq 区间，区间与实际注入一致', async () => {
    const feature = createFeature(); // pkg-1, 3 条 seed
    const recorder = createContextRecorder({ prefill: 2 });
    await inject(feature, recorder);

    const snapshot = feature.captureState() as Record<string, unknown>;
    assert.equal(snapshot.injected, true);
    assert.equal(snapshot.packageId, 'pkg-1');
    assert.equal(snapshot.seedCount, 3);
    // seed 落在 enriched[2..4]：first/last 指向实际注入区间（非下标推导）
    assert.equal(snapshot.firstMessageSeq, recorder.enrichedMessages[2].sequence);
    assert.equal(snapshot.lastMessageSeq, recorder.enrichedMessages[4].sequence);
    assert.equal(
      (snapshot.lastMessageSeq as number) - (snapshot.firstMessageSeq as number) + 1,
      3,
      'seq 区间长度应等于 seedCount（交叉校验契约）',
    );
  });

  it('importantFiles 注入不进入 seed 区间账目', async () => {
    const feature = new HandoffSeedFeature({
      handoff: {
        packageId: 'pkg-files',
        sourceSessionId: 'session-files',
        mode: 'trim-transcript',
        seedMessages: [
          { role: 'user', content: 'do work', turn: 1 },
          { role: 'assistant', content: 'done', turn: 1 },
        ],
        importantFiles: ['definitely-missing-file-for-test.ts'],
      },
    });
    const recorder = createContextRecorder();
    await inject(feature, recorder);

    // importantFiles 未命中 → name-only 补充块追加在 seed 段之后
    assert.ok(recorder.enrichedMessages.length > 2, 'important-file block should be injected after seed');
    const snapshot = feature.captureState() as Record<string, unknown>;
    assert.equal(snapshot.seedCount, 2);
    assert.equal(snapshot.firstMessageSeq, recorder.enrichedMessages[0].sequence);
    assert.equal(snapshot.lastMessageSeq, recorder.enrichedMessages[1].sequence);
  });

  it('无 seedMessages 但有 sourceSummary 时，快照记录单条合成注入', async () => {
    const feature = new HandoffSeedFeature({
      handoff: {
        packageId: 'pkg-label',
        sourceSessionId: 'session-label',
        mode: 'summary-message',
        sourceSummary: 'previous session overview',
      },
    });
    const recorder = createContextRecorder({ prefill: 1 });
    await inject(feature, recorder);

    const snapshot = feature.captureState() as Record<string, unknown>;
    assert.equal(snapshot.seedCount, 1);
    assert.equal(snapshot.firstMessageSeq, recorder.enrichedMessages[1].sequence);
    assert.equal(snapshot.lastMessageSeq, recorder.enrichedMessages[1].sequence);
  });

  it('旧快照（仅 injected:true）读取不报错，往返保持旧形态', () => {
    const feature = createFeature();
    feature.restoreState({ injected: true });
    assert.deepEqual(feature.captureState(), { injected: true });
  });

  it('新快照 restore 后 captureState 全等，且不重复注入', async () => {
    const source = createFeature();
    const recorderA = createContextRecorder({ prefill: 2 });
    await inject(source, recorderA);
    const snapshot = source.captureState();

    const target = createFeature();
    target.restoreState(JSON.parse(JSON.stringify(snapshot)));
    assert.deepEqual(target.captureState(), snapshot);

    const recorderB = createContextRecorder({ prefill: 2 });
    await inject(target, recorderB);
    assert.equal(recorderB.messages.length, 2, 'restore 后不得重复注入 seed');
  });
});
