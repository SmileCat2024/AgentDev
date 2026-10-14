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
      timestamps: [null],
      generation: 3,
    });
    expect(planMessagePush(first, second, 3)).toEqual({
      mode: 'append',
      messages: [second[1]],
      timestamps: [null],
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
      timestamps: [null],
      baseCount: 2,
      generation: 4,
    });
  });

  it('forces a full snapshot when the context generation changes', () => {
    const previous = [message('user', 'same')];
    expect(planMessagePush(previous, [...previous], 2, 1)).toEqual({
      mode: 'full',
      messages: previous,
      timestamps: [null],
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
      timestamps: [null, null],
      generation: 5,
    });
    expect(planMessagePush(previous, truncated, 6)).toEqual({
      mode: 'full',
      messages: truncated,
      timestamps: [null],
      generation: 6,
    });
  });

  it('suppresses identical snapshots', () => {
    const snapshot = [message('user', 'same')];
    expect(planMessagePush(snapshot, [...snapshot], 0)).toBeNull();
  });
});

describe('message push timestamps table', () => {
  it('slices the timestamps table along with append deltas', () => {
    const previous = [message('user', 'one')];
    const next = [...previous, message('assistant', 'two')];
    const ts = [111, 222];

    expect(planMessagePush(previous, next, 3, 3, ts)).toEqual({
      mode: 'append',
      messages: [next[1]],
      timestamps: [222],
      baseCount: 1,
      generation: 3,
    });
  });

  it('carries the replaced tail entry on tail deltas', () => {
    const previous = [message('user', 'one'), message('assistant', 'old')];
    const next = [message('user', 'one'), message('assistant', 'new')];

    expect(planMessagePush(previous, next, 4, 4, [111, 999])).toEqual({
      mode: 'tail',
      messages: [next[1]],
      timestamps: [999],
      baseCount: 2,
      generation: 4,
    });
  });

  it('pads missing entries with null and truncates overflow', () => {
    const previous = [message('user', 'one')];
    const next = [...previous, message('assistant', 'two')];

    // 缺位补 null
    expect(planMessagePush(previous, next, 3, 3, [111])).toEqual({
      mode: 'append',
      messages: [next[1]],
      timestamps: [null],
      baseCount: 1,
      generation: 3,
    });
    // 超长截断
    expect(planMessagePush(previous, next, 3, 3, [111, 222, 333])).toEqual({
      mode: 'append',
      messages: [next[1]],
      timestamps: [222],
      baseCount: 1,
      generation: 3,
    });
  });

  it('does not join timestamp equality into delta decisions', () => {
    // 时间表与 messages 是平行投影：messages 不变（同前缀同内容）时仍抑制推送，
    // 即使时间表不同也不触发 full-resync。
    const snapshot = [message('user', 'same')];
    expect(planMessagePush(snapshot, [...snapshot], 0, 0, [111])).toBeNull();
  });
});
