import { describe, it, expect } from 'vitest';
import { Context } from '../../core/context.js';
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
});
