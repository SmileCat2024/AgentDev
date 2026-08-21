import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  subscribeSessionEvents,
  emitSessionEvent,
  emitAssistantResponseEvents,
  emitToolResultEvents,
  emitTurnCompleted,
  emitTurnFailed,
  type SessionEvent,
} from '../../src/core/session-events.js';

describe('session-events', () => {
  let events: SessionEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = subscribeSessionEvents((e) => events.push(e));
  });

  afterEach(() => {
    unsubscribe();
  });

  it('subscribeSessionEvents 接收 emitSessionEvent 发出的事件', () => {
    emitSessionEvent({ type: 'thread.started', threadId: 't1' });
    expect(events).toEqual([{ type: 'thread.started', threadId: 't1' }]);
  });

  it('退订后不再接收事件', () => {
    unsubscribe();
    emitSessionEvent({ type: 'thread.started', threadId: 't1' });
    expect(events).toHaveLength(0);
  });

  it('无订阅者时 emit 零开销不抛错', () => {
    unsubscribe();
    expect(() => {
      emitAssistantResponseEvents({ content: 'hi', toolCalls: [] } as never, 1);
      emitToolResultEvents(
        { id: 'c1', name: 'shell', arguments: { cmd: 'ls' } },
        { success: true, result: 'ok' },
        1,
      );
    }).not.toThrow();
  });

  it('emitAssistantResponseEvents 映射 reasoning / agent_message / tool_call started', () => {
    emitAssistantResponseEvents(
      {
        content: 'done',
        reasoning: 'thinking...',
        toolCalls: [{ id: 'c1', name: 'shell', arguments: { cmd: 'ls' } }],
      } as never,
      3,
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking...' } });
    expect(events[1]).toMatchObject({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
    expect(events[2]).toMatchObject({
      type: 'item.started',
      item: { id: 'c1', type: 'tool_call', tool: 'shell', status: 'in_progress', turn: 3 },
    });
  });

  it('emitAssistantResponseEvents 跳过空 reasoning 与空 content', () => {
    emitAssistantResponseEvents({ content: '', reasoning: '  ' } as never, 1);
    expect(events).toHaveLength(0);
  });

  it('emitToolResultEvents 与 started 通过 call.id 配对并携带状态', () => {
    emitToolResultEvents(
      { id: 'c1', name: 'shell', arguments: { cmd: 'ls' } },
      { success: true, result: 'file.txt' },
      2,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'item.completed',
      item: { id: 'c1', status: 'completed', result: 'file.txt' },
    });

    emitToolResultEvents(
      { id: 'c2', name: 'read', arguments: { path: '/x' } },
      { success: false, result: '', error: 'not found' },
      2,
    );
    expect(events[1]).toMatchObject({
      type: 'item.completed',
      item: { id: 'c2', status: 'failed', error: 'not found' },
    });
  });

  it('emitTurnCompleted / emitTurnFailed 输出用量与结构化错误', () => {
    emitTurnCompleted(1, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    emitTurnFailed(2, 'interrupted');
    emitTurnFailed(3, {
      status: 'failed',
      reason: 'error',
      response: '[API Error] ...',
      steps: 1,
      startedAt: 1,
      finishedAt: 2,
      error: { category: 'rate_limit', message: 'API 请求频率超限 (429)', statusCode: 429, retryable: true },
    });
    expect(events[0]).toEqual({
      type: 'turn.completed',
      turn: 1,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(events[1]).toEqual({
      type: 'turn.failed',
      turn: 2,
      error: { message: 'interrupted' },
    });
    expect(events[2]).toEqual({
      type: 'turn.failed',
      turn: 3,
      error: {
        message: 'API 请求频率超限 (429)',
        reason: 'error',
        category: 'rate_limit',
        statusCode: 429,
        retryable: true,
      },
    });
  });

  it('订阅者抛异常不影响其他订阅者', () => {
    const received: SessionEvent[] = [];
    const unsubBad = subscribeSessionEvents(() => { throw new Error('boom'); });
    subscribeSessionEvents((e) => received.push(e));
    emitSessionEvent({ type: 'turn.started', turn: 1 });
    unsubBad();
    expect(received).toHaveLength(1);
  });
});
