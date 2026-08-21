import { describe, it, expect } from 'vitest';
import { Context, type ContextTombstoneEntry } from '../src/core/context.js';
import { Agent } from '../src/core/agent.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

// ========== Context 单元测试 ==========

/**
 * 构造一个带 n 条用户消息的 Context。
 */
function makeContext(...contents: string[]): Context {
  const ctx = new Context();
  contents.forEach((content, i) => ctx.addUserMessage(content, i));
  return ctx;
}

describe('Context tombstone (E1)', () => {
  describe('archive on truncate', () => {
    it('archives removed messages into a tombstone instead of discarding them', () => {
      const ctx = makeContext('m1', 'm2');
      const boundary = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.addUserMessage('m4', 3);
      expect(ctx.length).toBe(4);

      ctx.truncateToBoundary(boundary);

      // 截断后长度回到边界
      expect(ctx.length).toBe(2);
      // 被截内容进入 tombstone，不物理丢失
      const tombstones = ctx.listTombstones();
      expect(tombstones).toHaveLength(1);
      const entry = ctx.getTombstone(tombstones[0].id);
      expect(entry).toBeDefined();
      const removed = entry!.removedMessages.map(m =>
        typeof m.content === 'string' ? m.content : '',
      );
      expect(removed).toEqual(['m3', 'm4']);
    });

    it('does not create a tombstone when truncation removes nothing', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.truncateToBoundary(b);
      expect(ctx.listTombstones()).toHaveLength(0);
    });

    it('records boundary metadata and message count in the summary', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.truncateToBoundary(b);

      const [summary] = ctx.listTombstones();
      expect(summary.id).toBe(1);
      expect(summary.boundary).toEqual(b);
      expect(summary.removedMessageCount).toBe(1);
      expect(summary.truncatedAt).toBeDefined();
    });
  });

  describe('query', () => {
    it('listTombstones returns summaries without message content', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('secret-content', 2);
      ctx.truncateToBoundary(b);

      const summaries = ctx.listTombstones();
      expect(JSON.stringify(summaries)).not.toContain('secret-content');
    });

    it('getTombstone returns deep-cloned content (mutating it does not corrupt the archive)', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.truncateToBoundary(b);

      const id = ctx.listTombstones()[0].id;
      const first = ctx.getTombstone(id)!;
      (first.removedMessages[0] as { content: string }).content = 'TAMPERED';

      const second = ctx.getTombstone(id)!;
      expect(second.removedMessages[0].content).toBe('m3');
    });

    it('assigns monotonically increasing tombstone ids across multiple truncates', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 0);
      const b1 = ctx.captureBoundary();
      ctx.addUserMessage('b', 1);
      ctx.addUserMessage('c', 2);
      const b2 = ctx.captureBoundary();
      ctx.addUserMessage('d', 3);

      ctx.truncateToBoundary(b2);
      ctx.truncateToBoundary(b1);

      const ids = ctx.listTombstones().map(t => t.id);
      expect(ids).toEqual([1, 2]);
    });

    it('returns undefined for unknown tombstone id', () => {
      const ctx = makeContext('m1');
      expect(ctx.getTombstone(999)).toBeUndefined();
    });
  });

  describe('restoreTombstone', () => {
    it('restores the truncated tail when context is still exactly at the boundary', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.addUserMessage('m4', 3);
      ctx.truncateToBoundary(b);
      expect(ctx.length).toBe(2);

      const id = ctx.listTombstones()[0].id;
      ctx.restoreTombstone(id);

      expect(ctx.length).toBe(4);
      const contents = ctx.getAll().map(m => (typeof m.content === 'string' ? m.content : ''));
      expect(contents).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    it('refuses restore when messages were appended after the truncation', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.truncateToBoundary(b);
      ctx.addUserMessage('new-branch', 3);

      const id = ctx.listTombstones()[0].id;
      expect(() => ctx.restoreTombstone(id)).toThrow(/no longer at the tombstone boundary/);
    });

    it('keeps generation unchanged on restore (legal lineage operation)', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.truncateToBoundary(b);

      const genBefore = b.generation;
      ctx.restoreTombstone(ctx.listTombstones()[0].id);
      const genAfter = ctx.captureBoundary().generation;
      expect(genAfter).toBe(genBefore);
    });
  });

  describe('serialization roundtrip', () => {
    it('tombstones survive toJSON/fromJSON without field loss', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.truncateToBoundary(b);

      const original = ctx.getTombstone(1)!;
      const restored = Context.fromJSON(JSON.parse(JSON.stringify(ctx.toJSON())));

      const roundtripped = restored.getTombstone(1);
      expect(roundtripped).toBeDefined();
      // 字段级保真
      expect(roundtripped!.id).toBe(original.id);
      expect(roundtripped!.boundary).toEqual(original.boundary);
      expect(roundtripped!.truncatedAt).toBe(original.truncatedAt);
      expect(roundtripped!.removedMessages).toEqual(original.removedMessages);
      expect(
        roundtripped!.removedEnrichedMessages.map(e => e.content),
      ).toEqual(original.removedEnrichedMessages.map(e => e.content));
      // enriched 元数据保真
      expect(roundtripped!.removedEnrichedMessages[0].tags).toEqual(
        original.removedEnrichedMessages[0].tags,
      );
      expect(roundtripped!.removedEnrichedMessages[0].parsed).toEqual(
        original.removedEnrichedMessages[0].parsed,
      );

      // 序列化往返后 restore 仍然可用
      restored.restoreTombstone(1);
      expect(restored.length).toBe(3);
    });

    it('old snapshots without tombstones field load with empty archive', () => {
      const ctx = makeContext('m1');
      const snapshot = ctx.toJSON();
      delete (snapshot as Record<string, unknown>).tombstones;
      const restored = Context.fromJSON(snapshot);
      expect(restored.listTombstones()).toHaveLength(0);
    });

    it('tombstones are preserved across clear() (history is append-only)', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.truncateToBoundary(b);
      ctx.clear();

      expect(ctx.listTombstones()).toHaveLength(1);
      expect(ctx.getTombstone(1)!.removedMessages).toHaveLength(1);
    });
  });

  describe('field name contract (不乱命名)', () => {
    it('exposes stable camelCase fields on entry and summary', () => {
      const ctx = makeContext('m1', 'm2');
      const b = ctx.captureBoundary();
      ctx.addUserMessage('m3', 2);
      ctx.truncateToBoundary(b);

      const entryFields = Object.keys(ctx.getTombstone(1) as ContextTombstoneEntry).sort();
      expect(entryFields).toEqual(
        [
          'boundary',
          'id',
          'removedEnrichedMessages',
          'removedMessageCount',
          'removedMessages',
          'truncatedAt',
        ].sort(),
      );

      const summaryFields = Object.keys(ctx.listTombstones()[0]).sort();
      expect(summaryFields).toEqual(
        ['boundary', 'id', 'removedMessageCount', 'truncatedAt'].sort(),
      );

      const boundaryFields = Object.keys(ctx.listTombstones()[0].boundary).sort();
      expect(boundaryFields).toEqual(
        ['enrichedMessagesLength', 'generation', 'messagesLength', 'sequence'].sort(),
      );
    });
  });
});

// ========== Agent 集成测试 ==========

class EchoLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    return { content: `reply:${lastUser}` };
  }
}

class NoopFeature implements AgentFeature {
  readonly name = 'noop-feature';
  getTools(): Tool[] {
    return [];
  }
}

class TombstoneTestAgent extends Agent {
  constructor() {
    super({
      llm: new EchoLLM(),
      maxTurns: 2,
      name: 'TombstoneTestAgent',
      systemMessage: 'tombstone test',
    });
    this.use(new NoopFeature());
  }
}

describe('rollbackToCall tombstone integration', () => {
  it('rollbackToCall archives the truncated conversation into the context tombstone', async () => {
    const agent = new TombstoneTestAgent();
    await agent.onCall('first');
    await agent.onCall('second');
    await agent.onCall('third');

    await agent.rollbackToCall(1);

    const context = agent.getContext();
    expect(context.length).toBeGreaterThan(0);
    const userMessages = context.getAll().filter(m => m.role === 'user');
    expect(userMessages).toHaveLength(1); // 只剩 first

    // 被回滚的内容可取回
    const tombstones = context.listTombstones();
    expect(tombstones).toHaveLength(1);
    const entry = context.getTombstone(tombstones[0].id)!;
    const archivedUserContents = entry.removedMessages
      .filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content : ''));
    expect(archivedUserContents).toEqual(['second', 'third']);
  });

  it('multiple rollbacks stack tombstones in order', async () => {
    const agent = new TombstoneTestAgent();
    await agent.onCall('a');
    await agent.onCall('b');
    await agent.onCall('c');

    await agent.rollbackToCall(2); // 撤掉 c
    await agent.rollbackToCall(1); // 撤掉 b

    const summaries = agent.getContext().listTombstones();
    expect(summaries.map(t => t.id)).toEqual([1, 2]);
    // 每个 tombstone 记录各自被截的调用内容：先撤 c，再撤 b
    const first = agent.getContext().getTombstone(1)!;
    const second = agent.getContext().getTombstone(2)!;
    const firstUsers = first.removedMessages
      .filter(m => m.role === 'user')
      .map(m => m.content);
    const secondUsers = second.removedMessages
      .filter(m => m.role === 'user')
      .map(m => m.content);
    expect(firstUsers).toEqual(['c']);
    expect(secondUsers).toEqual(['b']);
  });
});
