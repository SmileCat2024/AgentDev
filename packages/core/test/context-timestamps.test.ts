/**
 * 消息时间戳盖戳与透传（会话时间线）。
 *
 * 覆盖：Context 写入 API 的可选 timestamp（缺省回退写入时刻）、
 * getTimestamps() 平行投影、trim 变换对 seed 产物的时间透传。
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { Context } from '../src/core/context.js';
import {
  buildTrimmedSeedMessages,
  normalizeExportPolicy,
  TrimTranscriptTransformation,
} from '../src/core/continuity/transforms/index.js';

describe('context message timestamps', () => {
  it('stamps Date.now() by default and honors explicit timestamps', () => {
    const ctx = new Context();
    const before = Date.now();
    ctx.addUserMessage('default-stamp', 0);
    const after = Date.now();

    const explicit = 1700000000000;
    ctx.addUserMessage('explicit-stamp', 0, undefined, explicit);
    ctx.addSystemMessage('sys-explicit', 0, 'src', 'tag', explicit);
    ctx.addAssistantMessage({ content: 'assistant-explicit' }, 0, explicit);

    const ts = ctx.getTimestamps();
    assert.equal(ts.length, 4);
    assert.ok(ts[0]! >= before && ts[0]! <= after, 'default stamp should be write-time');
    assert.equal(ts[1], explicit);
    assert.equal(ts[2], explicit);
    assert.equal(ts[3], explicit);
  });

  it('degrades getTimestamps entries to null on structural mismatch', () => {
    const ctx = new Context();
    ctx.addUserMessage('one', 0);
    // 模拟结构失配的旧快照：enriched 侧缺位
    (ctx as any).enrichedMessages = [];
    assert.deepEqual(ctx.getTimestamps(), [null]);
  });

  it('keeps enriched aligned on legacy add() (feature injection path)', () => {
    const ctx = new Context();
    ctx.addUserMessage('user-msg', 0);
    const before = Date.now();
    ctx.add({ role: 'system', content: 'reminder', turn: 0 } as any);
    const after = Date.now();
    ctx.addUserMessage('next-user', 1);

    const ts = ctx.getTimestamps();
    assert.equal(ts.length, 3);
    // add() 注入条目带注入时刻锚，后续消息索引不错位
    assert.ok(ts[1]! >= before && ts[1]! <= after, 'add() should stamp injection time');
    assert.ok(typeof ts[2] === 'number', 'subsequent messages keep aligned anchors');
  });

  it('backfills missing enriched entries on restore with null anchors', () => {
    const ctx = new Context();
    ctx.addUserMessage('one', 0, undefined, 1700000000001);
    ctx.addUserMessage('two', 0, undefined, 1700000000002);
    // 模拟失配快照：enriched 侧只有第一条
    const snapshot = ctx.toJSON();
    (snapshot.enrichedMessages as any[]).pop();

    const restored = Context.fromJSON(snapshot);
    assert.equal(restored.length, 2);
    // 失配条目补建为 null（无锚），已存在的锚保留
    assert.deepEqual(restored.getTimestamps(), [1700000000001, null]);
    // 补建后继续追加，索引不再错位
    restored.addUserMessage('three', 1, undefined, 1700000000003);
    assert.deepEqual(restored.getTimestamps(), [1700000000001, null, 1700000000003]);
  });

  it('serializes timestamps through the snapshot roundtrip', () => {
    const ctx = new Context();
    const explicit = 1700000001234;
    ctx.addUserMessage('kept', 0, undefined, explicit);
    const restored = Context.fromJSON(JSON.parse(JSON.stringify(ctx.toJSON())));
    assert.equal(restored.getTimestamps()[0], explicit);
  });
});

describe('trim transformation timestamp passthrough', () => {
  it('passes timestamps into retained seed messages', () => {
    const rawMessages = [
      { role: 'user', content: 'early', turn: 0 },
      { role: 'assistant', content: 'reply', turn: 0 },
    ];
    const policy = normalizeExportPolicy({ fullPreserveFromTurn: 0 });
    const { seedMessages } = buildTrimmedSeedMessages(rawMessages, policy, [111, 222]);

    assert.equal(seedMessages.length, 2);
    assert.equal((seedMessages[0] as any).timestamp, 111);
    assert.equal((seedMessages[1] as any).timestamp, 222);
  });

  it('omits the timestamp field when no table is given (golden-compatible)', () => {
    const rawMessages = [
      { role: 'user', content: 'early', turn: 0 },
    ];
    const policy = normalizeExportPolicy({ fullPreserveFromTurn: 0 });
    const { seedMessages } = buildTrimmedSeedMessages(rawMessages, policy);

    assert.equal(seedMessages.length, 1);
    assert.equal('timestamp' in (seedMessages[0] as any), false);
  });

  it('does not stamp the synthesized folded-tool note', () => {
    const rawMessages = [
      { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'read', arguments: '{}' }] },
      { role: 'user', content: 'next', turn: 1 },
    ];
    const policy = normalizeExportPolicy({ toolMessageMode: 'fold', assistantToolCallMode: 'fold' });
    const { seedMessages } = buildTrimmedSeedMessages(rawMessages, policy, [111, 222]);

    const foldedNote = seedMessages.find(m => (m as any).tag === 'folded-tool-activity');
    assert.ok(foldedNote, 'folded note should exist');
    assert.equal('timestamp' in (foldedNote as any), false);
  });

  it('transfers timestamps from snapshot enrichedMessages in transform()', async () => {
    const transformation = new TrimTranscriptTransformation();
    const sourceSnapshot: any = {
      runtime: {
        context: {
          messages: [
            { role: 'user', content: 'hello', turn: 0 },
            { role: 'assistant', content: 'hi', turn: 0 },
          ],
          enrichedMessages: [
            { role: 'user', timestamp: 1700000000001 },
            { role: 'assistant', timestamp: 1700000000002 },
          ],
        },
      },
    };

    const seed = await transformation.transform({ sourceSnapshot } as any, {} as any);
    assert.equal((seed.seedMessages[0] as any).timestamp, 1700000000001);
    assert.equal((seed.seedMessages[1] as any).timestamp, 1700000000002);
  });

  it('degrades to no timestamps when snapshot enriched side is missing', async () => {
    const transformation = new TrimTranscriptTransformation();
    const sourceSnapshot: any = {
      runtime: {
        context: {
          messages: [{ role: 'user', content: 'hello', turn: 0 }],
        },
      },
    };

    const seed = await transformation.transform({ sourceSnapshot } as any, {} as any);
    assert.equal('timestamp' in (seed.seedMessages[0] as any), false);
  });
});
