import type { Message, MessagePushMode, PushMessagesMsg } from './types.js';

export interface MessagePushPlan {
  mode: MessagePushMode;
  messages: Message[];
  /** 与 messages 等长对齐的时间元表（毫秒；null = 无时间锚）。 */
  timestamps: (number | null)[];
  baseCount?: number;
  generation?: number;
}

function sameMessage(left: Message, right: Message): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function samePrefix(previous: Message[], next: Message[], length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (!sameMessage(previous[index], next[index])) return false;
  }
  return true;
}

/**
 * Classify a full Context snapshot into the conservative B-protocol delta.
 *
 * The caller still owns the full snapshot. This helper only decides which
 * portion is safe to put on the wire; any ambiguous mutation becomes full.
 *
 * `nextTimestamps`（与 next 等长的时间元表）按同一增量切片随行；增量比较
 * 仍只基于 messages——时间表是 enriched 侧的投影，不参与 JSON 等值判定。
 */
export function planMessagePush(
  previous: Message[] | undefined,
  next: Message[],
  generation = 0,
  previousGeneration = generation,
  nextTimestamps?: (number | null)[],
): MessagePushPlan | null {
  const alignedTimestamps = (length: number): (number | null)[] => {
    if (!Array.isArray(nextTimestamps)) return new Array(length).fill(null);
    // 与传入切片等长对齐；超长截断、缺位补 null
    return Array.from({ length }, (_, i) => nextTimestamps[i] ?? null);
  };

  if (!previous) {
    return { mode: 'full', messages: next, timestamps: alignedTimestamps(next.length), generation };
  }

  if (generation !== previousGeneration) {
    return { mode: 'full', messages: next, timestamps: alignedTimestamps(next.length), generation };
  }

  if (previous.length === next.length && samePrefix(previous, next, next.length)) {
    return null;
  }

  if (next.length > previous.length && samePrefix(previous, next, previous.length)) {
    const timestamps = alignedTimestamps(next.length);
    return {
      mode: 'append',
      messages: next.slice(previous.length),
      timestamps: timestamps.slice(previous.length),
      baseCount: previous.length,
      generation,
    };
  }

  if (previous.length === next.length && next.length > 0 && samePrefix(previous, next, next.length - 1)) {
    const timestamps = alignedTimestamps(next.length);
    return {
      mode: 'tail',
      messages: [next[next.length - 1]],
      timestamps: [timestamps[next.length - 1]],
      baseCount: previous.length,
      generation,
    };
  }

  return { mode: 'full', messages: next, timestamps: alignedTimestamps(next.length), generation };
}

export function asMessagePush(agentId: string, plan: MessagePushPlan): PushMessagesMsg {
  if (plan.mode === 'full') {
    return {
      type: 'push-messages',
      agentId,
      messages: plan.messages,
      timestamps: plan.timestamps,
      mode: 'full',
      generation: plan.generation,
    };
  }

  return {
    type: 'push-messages',
    agentId,
    messages: plan.messages,
    timestamps: plan.timestamps,
    mode: plan.mode,
    baseCount: plan.baseCount!,
    generation: plan.generation!,
  };
}
