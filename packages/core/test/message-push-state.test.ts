import { describe, expect, it } from 'vitest';
import { planMessagePush } from '../src/core/message-push-state.js';
import type { Message } from '../src/core/types.js';

function message(role: Message['role'], content: string): Message {
  return { role, content };
}

describe('message push delta planning', () => {
  it('starts with full and then emits append for a pure suffix', () => {
    const first = [message('user', 'one')];
    const second = [...first, message('assistant', 'two')];

    expect(planMessagePush(undefined, first, 3)).toEqual({
      mode: 'full',
      messages: first,
      generation: 3,
    });
    expect(planMessagePush(first, second, 3)).toEqual({
      mode: 'append',
      messages: [second[1]],
      baseCount: 1,
      generation: 3,
    });
  });

  it('emits tail only when the prefix is unchanged', () => {
    const previous = [message('user', 'one'), message('assistant', 'old')];
    const next = [message('user', 'one'), message('assistant', 'new')];

    expect(planMessagePush(previous, next, 4)).toEqual({
      mode: 'tail',
      messages: [next[1]],
      baseCount: 2,
      generation: 4,
    });
  });

  it('forces a full snapshot when the context generation changes', () => {
    const previous = [message('user', 'same')];
    expect(planMessagePush(previous, [...previous], 2, 1)).toEqual({
      mode: 'full',
      messages: previous,
      generation: 2,
    });
  });

  it('falls back to full for rewrite and truncate', () => {
    const previous = [message('user', 'one'), message('assistant', 'two')];
    const rewritten = [message('user', 'changed'), message('assistant', 'two')];
    const truncated = [previous[0]];

    expect(planMessagePush(previous, rewritten, 5)).toEqual({
      mode: 'full',
      messages: rewritten,
      generation: 5,
    });
    expect(planMessagePush(previous, truncated, 6)).toEqual({
      mode: 'full',
      messages: truncated,
      generation: 6,
    });
  });

  it('suppresses identical snapshots', () => {
    const snapshot = [message('user', 'same')];
    expect(planMessagePush(snapshot, [...snapshot], 0)).toBeNull();
  });
});
