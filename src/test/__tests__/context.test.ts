import { describe, it, expect } from 'vitest';
import { Context } from '../../core/context.js';
import type { ContextBoundaryV2 } from '../../core/context.js';
import type { LLMResponse, ToolCall } from '../../core/types.js';

/** Helper: create a minimal LLMResponse */
function makeResponse(content: string, toolCalls?: ToolCall[]): LLMResponse {
  return {
    content,
    toolCalls,
    role: 'assistant',
  };
}

/** Helper: create a ToolCall */
function makeToolCall(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

describe('Context', () => {
  // ========== Basic message operations ==========

  describe('add / getAll / length', () => {
    it('should add and retrieve messages', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'hello', turn: 0 });
      ctx.add({ role: 'assistant', content: 'hi', turn: 0 });
      expect(ctx.length).toBe(2);
      const msgs = ctx.getAll();
      expect(msgs[0].content).toBe('hello');
      expect(msgs[1].content).toBe('hi');
    });

    it('should add multiple messages via addAll', () => {
      const ctx = new Context();
      ctx.addAll([
        { role: 'user', content: 'a', turn: 0 },
        { role: 'user', content: 'b', turn: 0 },
        { role: 'user', content: 'c', turn: 0 },
      ]);
      expect(ctx.length).toBe(3);
    });

    it('should return a copy from getAll (immutability)', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'original', turn: 0 });
      const msgs = ctx.getAll();
      msgs[0].content = 'mutated';
      // Original should be unchanged
      expect(ctx.getAll()[0].content).toBe('original');
    });
  });

  describe('getLast', () => {
    it('should return the last message', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'first', turn: 0 });
      ctx.add({ role: 'assistant', content: 'last', turn: 0 });
      expect(ctx.getLast()?.content).toBe('last');
    });

    it('should return undefined for empty context', () => {
      const ctx = new Context();
      expect(ctx.getLast()).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should clear all messages', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'a', turn: 0 });
      ctx.clear();
      expect(ctx.length).toBe(0);
    });
  });

  describe('apply (middleware)', () => {
    it('should apply middleware to transform messages', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'a', turn: 0 });
      ctx.add({ role: 'user', content: 'b', turn: 0 });
      ctx.apply(msgs => msgs.filter(m => m.content === 'b'));
      expect(ctx.length).toBe(1);
      expect(ctx.getAll()[0].content).toBe('b');
    });
  });

  describe('filter & slice', () => {
    it('should filter messages', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'a', turn: 0 });
      ctx.add({ role: 'system', content: 'sys', turn: 0 });
      const filtered = ctx.filter(m => m.role === 'system');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].content).toBe('sys');
    });

    it('should slice messages', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'a', turn: 0 });
      ctx.add({ role: 'user', content: 'b', turn: 0 });
      ctx.add({ role: 'user', content: 'c', turn: 0 });
      const sliced = ctx.slice(1, 3);
      expect(sliced).toHaveLength(2);
      expect(sliced[0].content).toBe('b');
    });
  });

  // ========== Enriched message methods ==========

  describe('addUserMessage', () => {
    it('should add enriched user message with tags', () => {
      const ctx = new Context();
      ctx.addUserMessage('hello', 1);
      const enriched = ctx.getAllEnriched();
      expect(enriched).toHaveLength(1);
      expect(enriched[0].role).toBe('user');
      expect(enriched[0].tags).toContain('user');
      expect(enriched[0].turn).toBe(1);
    });
  });

  describe('addAssistantMessage', () => {
    it('should add enriched assistant message', () => {
      const ctx = new Context();
      const response = makeResponse('hello');
      ctx.addAssistantMessage(response, 1);
      const enriched = ctx.getAllEnriched();
      expect(enriched[0].role).toBe('assistant');
      expect(enriched[0].tags).toContain('assistant');
      expect(enriched[0].content).toBe('hello');
    });

    it('should tag tool-call when response has toolCalls', () => {
      const ctx = new Context();
      const response = makeResponse('calling tool', [makeToolCall('tc1', 'search')]);
      ctx.addAssistantMessage(response, 1);
      const enriched = ctx.getAllEnriched();
      expect(enriched[0].tags).toContain('tool-call');
    });

    it('should extract usage from response', () => {
      const ctx = new Context();
      const response: LLMResponse = {
        content: 'ok',
        role: 'assistant',
        usage: { inputTokens: 100, outputTokens: 50 },
      };
      ctx.addAssistantMessage(response, 1);
      const msgs = ctx.getAll();
      expect(msgs[0].usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });
  });

  describe('addToolMessage', () => {
    it('should add enriched tool result message', () => {
      const ctx = new Context();
      const call = makeToolCall('tc1', 'search');
      ctx.addToolMessage(call, { success: true, result: 'found it' }, 1);
      const enriched = ctx.getAllEnriched();
      expect(enriched[0].role).toBe('tool');
      expect(enriched[0].tags).toContain('tool-result');
      expect(enriched[0].toolCallId).toBe('tc1');
    });

    it('should include error in serialized content', () => {
      const ctx = new Context();
      const call = makeToolCall('tc1', 'search');
      ctx.addToolMessage(call, { success: false, result: '', error: 'failed' }, 1);
      const msgs = ctx.getAll();
      const parsed = JSON.parse(msgs[0].content);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('failed');
    });
  });

  describe('addSystemMessage', () => {
    it('should add enriched system message with tag', () => {
      const ctx = new Context();
      ctx.addSystemMessage('you are helpful', 0);
      const enriched = ctx.getAllEnriched();
      expect(enriched[0].role).toBe('system');
      expect(enriched[0].tags).toContain('system');
    });
  });

  // ========== Parsed content & indexes ==========

  describe('parsed content extraction', () => {
    it('should extract taskId from content', () => {
      const ctx = new Context();
      ctx.addUserMessage('{"taskId":"abc123"} do something', 1);
      const enriched = ctx.getAllEnriched();
      expect(enriched[0].parsed.taskIds).toContain('abc123');
    });

    it('should extract @mentions from content', () => {
      const ctx = new Context();
      ctx.addUserMessage('hey @alice and @bob', 1);
      const enriched = ctx.getAllEnriched();
      expect(enriched[0].parsed.mentions).toEqual(expect.arrayContaining(['alice', 'bob']));
    });

    it('should extract tool call names from toolCalls', () => {
      const ctx = new Context();
      const response = makeResponse('calling', [makeToolCall('tc1', 'search'), makeToolCall('tc2', 'write')]);
      ctx.addAssistantMessage(response, 1);
      const enriched = ctx.getAllEnriched();
      expect(enriched[0].parsed.toolCalls).toEqual(expect.arrayContaining(['search', 'write']));
    });
  });

  // ========== Query ==========

  describe('query()', () => {
    it('should filter by role', () => {
      const ctx = new Context();
      ctx.addUserMessage('u1', 1);
      ctx.addAssistantMessage(makeResponse('a1'), 1);
      ctx.addUserMessage('u2', 2);
      const results = ctx.query().byRole('user').exec();
      expect(results).toHaveLength(2);
    });

    it('should filter by tag', () => {
      const ctx = new Context();
      ctx.addAssistantMessage(makeResponse('a1', [makeToolCall('tc1', 'search')]), 1);
      ctx.addAssistantMessage(makeResponse('a2'), 2);
      const results = ctx.query().byTag('tool-call').exec();
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('a1');
    });

    it('should filter by tool name', () => {
      const ctx = new Context();
      ctx.addAssistantMessage(makeResponse('a1', [makeToolCall('tc1', 'search')]), 1);
      ctx.addAssistantMessage(makeResponse('a2', [makeToolCall('tc2', 'write')]), 2);
      const results = ctx.query().byTool('search').exec();
      expect(results).toHaveLength(1);
    });

    it('should filter by turn range', () => {
      const ctx = new Context();
      ctx.addUserMessage('u1', 1);
      ctx.addUserMessage('u2', 2);
      ctx.addUserMessage('u3', 3);
      const results = ctx.query().inTurns(2, 3).exec();
      expect(results).toHaveLength(2);
    });

    it('should filter by containing text', () => {
      const ctx = new Context();
      ctx.addUserMessage('find this keyword', 1);
      ctx.addUserMessage('nothing here', 2);
      const results = ctx.query().containing('keyword').exec();
      expect(results).toHaveLength(1);
    });

    it('should get recent N messages', () => {
      const ctx = new Context();
      ctx.addUserMessage('u1', 1);
      ctx.addUserMessage('u2', 2);
      ctx.addUserMessage('u3', 3);
      const results = ctx.query().recent(2).exec();
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('u2');
    });

    it('should chain filters', () => {
      const ctx = new Context();
      ctx.addUserMessage('hello world', 1);
      ctx.addAssistantMessage(makeResponse('hello back'), 1);
      ctx.addUserMessage('hello again', 2);
      const results = ctx.query().byRole('user').containing('hello').exec();
      expect(results).toHaveLength(2);
    });

    it('should count results', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addUserMessage('b', 1);
      expect(ctx.query().byRole('user').count()).toBe(2);
    });

    it('should group by tool', () => {
      const ctx = new Context();
      ctx.addAssistantMessage(makeResponse('a', [makeToolCall('tc1', 'search')]), 1);
      ctx.addAssistantMessage(makeResponse('b', [makeToolCall('tc2', 'search'), makeToolCall('tc3', 'write')]), 2);
      const stats = ctx.query().groupByTool();
      expect(stats).toEqual({ search: 2, write: 1 });
    });

    it('should calculate timeSpan', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addUserMessage('b', 1);
      const span = ctx.query().timeSpan();
      expect(span.duration).toBeGreaterThanOrEqual(0);
      expect(span.start).toBeGreaterThan(0);
    });

    it('should return empty timeSpan for no messages', () => {
      const ctx = new Context();
      const span = ctx.query().timeSpan();
      expect(span).toEqual({ start: 0, end: 0, duration: 0 });
    });

    it('should get first and last', () => {
      const ctx = new Context();
      ctx.addUserMessage('first', 1);
      ctx.addUserMessage('second', 2);
      expect(ctx.query().first()?.content).toBe('first');
      expect(ctx.query().last()?.content).toBe('second');
    });
  });

  // ========== getByTurn / getRecent ==========

  describe('getByTurn', () => {
    it('should return messages for a specific turn', () => {
      const ctx = new Context();
      ctx.addUserMessage('u1', 1);
      ctx.addAssistantMessage(makeResponse('a1'), 1);
      ctx.addUserMessage('u2', 2);
      const turn1 = ctx.getByTurn(1);
      expect(turn1).toHaveLength(2);
    });
  });

  describe('getRecent', () => {
    it('should return N most recent enriched messages', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addUserMessage('b', 2);
      ctx.addUserMessage('c', 3);
      const recent = ctx.getRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[1].content).toBe('c');
    });
  });

  // ========== Serialization ==========

  describe('toJSON / fromJSON / restore', () => {
    it('should serialize and restore basic messages', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'hello', turn: 0 });
      ctx.add({ role: 'assistant', content: 'hi', turn: 0 });
      const snapshot = ctx.toJSON();
      const restored = Context.fromJSON(snapshot);
      expect(restored.length).toBe(2);
      expect(restored.getAll()[0].content).toBe('hello');
    });

    it('should serialize and restore enriched messages', () => {
      const ctx = new Context();
      ctx.addUserMessage('u1', 1);
      ctx.addAssistantMessage(makeResponse('a1', [makeToolCall('tc1', 'search')]), 1);
      const snapshot = ctx.toJSON();
      const restored = Context.fromJSON(snapshot);
      const enriched = restored.getAllEnriched();
      expect(enriched).toHaveLength(2);
      expect(enriched[1].tags).toContain('tool-call');
    });

    it('should serialize and restore indexes', () => {
      const ctx = new Context();
      ctx.addAssistantMessage(makeResponse('a', [makeToolCall('tc1', 'search')]), 1);
      const snapshot = ctx.toJSON();
      const restored = Context.fromJSON(snapshot);
      // Index should be rebuilt — query by tool should work
      const results = restored.query().byTool('search').exec();
      expect(results).toHaveLength(1);
    });

    it('should support restore() in-place', () => {
      const ctx = new Context();
      ctx.addUserMessage('old', 1);
      const snapshot = ctx.toJSON();

      const ctx2 = new Context();
      ctx2.addUserMessage('other', 1);
      ctx2.restore(snapshot);
      expect(ctx2.length).toBe(1);
      expect(ctx2.getAll()[0].content).toBe('old');
    });
  });

  describe('serialize / deserialize', () => {
    it('should round-trip through JSON string', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'test', turn: 0 });
      const json = ctx.serialize();
      const restored = Context.deserialize(json);
      expect(restored.length).toBe(1);
      expect(restored.getAll()[0].content).toBe('test');
    });
  });

  // ========== Sequence ==========

  describe('sequence numbering', () => {
    it('should assign increasing sequence numbers', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addUserMessage('b', 1);
      const enriched = ctx.getAllEnriched();
      expect(enriched[1].sequence).toBeGreaterThan(enriched[0].sequence);
    });
  });

  // ========== 边界原语 ==========

  describe('captureBoundary', () => {
    it('should capture current array lengths, sequence and generation', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addAssistantMessage(makeResponse('b'), 1);
      const boundary = ctx.captureBoundary();
      expect(boundary.messagesLength).toBe(2);
      expect(boundary.enrichedMessagesLength).toBe(2);
      expect(boundary.sequence).toBe(2);
      expect(boundary.generation).toBe(0);
    });

    it('should not change generation', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.captureBoundary();
      ctx.captureBoundary();
      // Multiple captures don't change generation
      const boundary = ctx.captureBoundary();
      expect(boundary.generation).toBe(0);
    });
  });

  describe('truncateToBoundary', () => {
    it('should truncate both arrays to equal lengths', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addAssistantMessage(makeResponse('b'), 1);
      ctx.addUserMessage('c', 2);

      const boundary = ctx.captureBoundary();
      ctx.addUserMessage('d', 3);

      ctx.truncateToBoundary(boundary);
      expect(ctx.length).toBe(3);
      expect(ctx.getAllEnriched()).toHaveLength(3);
      expect(ctx.getAll()[2].content).toBe('c');
    });

    it('should truncate when messages and enriched have different lengths', () => {
      const ctx = new Context();
      // add() only pushes to messages[], not enrichedMessages[]
      ctx.add({ role: 'user', content: 'legacy', turn: 0 });
      ctx.addUserMessage('typed', 1);

      // messages: [legacy, typed], enriched: [typed]
      expect(ctx.length).toBe(2);
      expect(ctx.getAllEnriched()).toHaveLength(1);

      const boundary = ctx.captureBoundary();
      ctx.addUserMessage('extra', 2);

      ctx.truncateToBoundary(boundary);
      expect(ctx.length).toBe(2);
      expect(ctx.getAllEnriched()).toHaveLength(1);
    });

    it('should restore sequence after truncation', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addUserMessage('b', 1);
      const seqBefore = ctx.captureBoundary().sequence;

      ctx.addUserMessage('c', 2);
      const seqAfter = ctx.captureBoundary().sequence;
      expect(seqAfter).toBeGreaterThan(seqBefore);

      ctx.truncateToBoundary({ messagesLength: 2, enrichedMessagesLength: 2, sequence: seqBefore, generation: 0 });
      // After truncation, sequence should be restored
      ctx.addUserMessage('d', 2);
      const enriched = ctx.getAllEnriched();
      expect(enriched[2].sequence).toBe(seqBefore);
    });

    it('should rebuild indexes after truncation', () => {
      const ctx = new Context();
      ctx.addAssistantMessage(makeResponse('a', [makeToolCall('tc1', 'search')]), 1);
      ctx.addAssistantMessage(makeResponse('b', [makeToolCall('tc2', 'write')]), 2);
      const boundary = ctx.captureBoundary();
      ctx.addAssistantMessage(makeResponse('c', [makeToolCall('tc3', 'read')]), 3);

      ctx.truncateToBoundary(boundary);
      // search tool is in the retained part — index should still work
      expect(ctx.query().byTool('search').exec()).toHaveLength(1);
      // Third message should be gone
      const enriched = ctx.getAllEnriched();
      expect(enriched).toHaveLength(2);
      expect(enriched.every(m => m.content !== 'c')).toBe(true);
    });

    it('should truncate to empty boundary', () => {
      const ctx = new Context();
      const emptyBoundary = ctx.captureBoundary();
      ctx.addUserMessage('a', 1);
      ctx.addUserMessage('b', 2);

      ctx.truncateToBoundary(emptyBoundary);
      expect(ctx.length).toBe(0);
      expect(ctx.getAllEnriched()).toHaveLength(0);
    });

    it('should truncate to boundary captured after add() then typed add()', () => {
      const ctx = new Context();
      ctx.add({ role: 'user', content: 'legacy1', turn: 0 });
      ctx.addUserMessage('typed1', 1);
      ctx.add({ role: 'user', content: 'legacy2', turn: 0 });
      // messages: [legacy1, typed1, legacy2], enriched: [typed1]
      const boundary = ctx.captureBoundary();

      ctx.addUserMessage('typed2', 2);
      ctx.add({ role: 'user', content: 'legacy3', turn: 0 });
      // messages: [legacy1, typed1, legacy2, typed2, legacy3], enriched: [typed1, typed2]

      ctx.truncateToBoundary(boundary);
      expect(ctx.length).toBe(3);
      expect(ctx.getAllEnriched()).toHaveLength(1);
    });
  });

  describe('truncateToBoundary validation', () => {
    it('should reject messagesLength exceeding current length', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      expect(ctx.length).toBe(1);

      const bad: ContextBoundaryV2 = {
        messagesLength: 5,
        enrichedMessagesLength: 1,
        sequence: 1,
        generation: 0,
      };
      expect(() => ctx.truncateToBoundary(bad)).toThrow(/exceeds current length/);
    });

    it('should reject enrichedMessagesLength exceeding current length', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);

      const bad: ContextBoundaryV2 = {
        messagesLength: 1,
        enrichedMessagesLength: 5,
        sequence: 1,
        generation: 0,
      };
      expect(() => ctx.truncateToBoundary(bad)).toThrow(/exceeds current length/);
    });

    it('should reject negative messagesLength', () => {
      const ctx = new Context();
      const bad: ContextBoundaryV2 = {
        messagesLength: -1,
        enrichedMessagesLength: 0,
        sequence: 0,
        generation: 0,
      };
      expect(() => ctx.truncateToBoundary(bad)).toThrow(/non-negative integer/);
    });

    it('should reject non-integer enrichedMessagesLength', () => {
      const ctx = new Context();
      const bad: ContextBoundaryV2 = {
        messagesLength: 0,
        enrichedMessagesLength: 1.5,
        sequence: 0,
        generation: 0,
      };
      expect(() => ctx.truncateToBoundary(bad)).toThrow(/non-negative integer/);
    });

    it('should reject generation mismatch after clear', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      const boundary = ctx.captureBoundary();

      ctx.clear();
      ctx.addUserMessage('b', 1);

      expect(() => ctx.truncateToBoundary(boundary)).toThrow(/generation mismatch/);
    });

    it('should reject generation mismatch after apply', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      const boundary = ctx.captureBoundary();

      ctx.apply(msgs => [...msgs, { role: 'user', content: 'extra', turn: 0 }]);

      expect(() => ctx.truncateToBoundary(boundary)).toThrow(/generation mismatch/);
    });

    it('should reject generation mismatch after restore to different lineage', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      const boundary = ctx.captureBoundary(); // generation 0

      // Simulate loading a legacy snapshot (no generation field)
      // restore() will increment generation since snapshot has no generation
      const legacySnapshot = { version: 2, messages: [{ role: 'user', content: 'x', turn: 0 }] };
      ctx.restore(legacySnapshot); // generation → 1

      expect(() => ctx.truncateToBoundary(boundary)).toThrow(/generation mismatch/);
    });
  });

  describe('generation invalidation', () => {
    it('clear should increment generation', () => {
      const ctx = new Context();
      expect(ctx.captureBoundary().generation).toBe(0);
      ctx.clear();
      expect(ctx.captureBoundary().generation).toBe(1);
    });

    it('apply should increment generation', () => {
      const ctx = new Context();
      ctx.apply(msgs => msgs);
      expect(ctx.captureBoundary().generation).toBe(1);
    });

    it('restore with generation in snapshot should preserve it', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.clear(); // gen → 1
      ctx.addUserMessage('b', 1);
      const snapshot = ctx.toJSON();
      expect(snapshot.generation).toBe(1);

      const ctx2 = new Context();
      ctx2.restore(snapshot);
      expect(ctx2.captureBoundary().generation).toBe(1);
    });

    it('restore without generation in snapshot should increment', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.clear(); // gen → 1
      ctx.addUserMessage('b', 1);
      const snapshot = ctx.toJSON();
      delete (snapshot as any).generation;

      const ctx2 = new Context();
      // new Context has gen 0, restore without generation → gen becomes 1
      ctx2.restore(snapshot);
      expect(ctx2.captureBoundary().generation).toBe(1);
    });

    it('typed adds should not change generation', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addAssistantMessage(makeResponse('b'), 1);
      ctx.addSystemMessage('sys', 0);
      const call = makeToolCall('tc1', 'search');
      ctx.addToolMessage(call, { success: true, result: 'ok' }, 1);
      expect(ctx.captureBoundary().generation).toBe(0);
    });

    it('truncateToBoundary should not change generation', () => {
      const ctx = new Context();
      ctx.addUserMessage('a', 1);
      ctx.addUserMessage('b', 2);
      const boundary = ctx.captureBoundary();
      ctx.addUserMessage('c', 3);

      ctx.truncateToBoundary(boundary);
      expect(ctx.captureBoundary().generation).toBe(0);

      // Can still use the original boundary after truncation
      ctx.addUserMessage('d', 3);
      ctx.truncateToBoundary(boundary);
      expect(ctx.length).toBe(2);
    });

    it('boundary should remain usable after multiple typed adds and truncations', () => {
      const ctx = new Context();
      ctx.addUserMessage('base', 1);
      const boundary = ctx.captureBoundary();

      // Cycle 1
      ctx.addUserMessage('c1', 2);
      ctx.truncateToBoundary(boundary);
      expect(ctx.length).toBe(1);

      // Cycle 2
      ctx.addUserMessage('c2', 2);
      ctx.addAssistantMessage(makeResponse('c2r'), 2);
      ctx.truncateToBoundary(boundary);
      expect(ctx.length).toBe(1);

      // Boundary still valid
      expect(ctx.captureBoundary().generation).toBe(boundary.generation);
    });
  });
});
