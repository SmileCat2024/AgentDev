import type { Message, MessagePushMode, PushMessagesMsg } from './types.js';

export interface MessagePushPlan {
  mode: MessagePushMode;
  messages: Message[];
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
 */
export function planMessagePush(
  previous: Message[] | undefined,
  next: Message[],
  generation = 0,
  previousGeneration = generation,
): MessagePushPlan | null {
  if (!previous) {
    return { mode: 'full', messages: next, generation };
  }

  if (generation !== previousGeneration) {
    return { mode: 'full', messages: next, generation };
  }

  if (previous.length === next.length && samePrefix(previous, next, next.length)) {
    return null;
  }

  if (next.length > previous.length && samePrefix(previous, next, previous.length)) {
    return {
      mode: 'append',
      messages: next.slice(previous.length),
      baseCount: previous.length,
      generation,
    };
  }

  if (previous.length === next.length && next.length > 0 && samePrefix(previous, next, next.length - 1)) {
    return {
      mode: 'tail',
      messages: [next[next.length - 1]],
      baseCount: previous.length,
      generation,
    };
  }

  return { mode: 'full', messages: next, generation };
}

export function asMessagePush(agentId: string, plan: MessagePushPlan): PushMessagesMsg {
  if (plan.mode === 'full') {
    return {
      type: 'push-messages',
      agentId,
      messages: plan.messages,
      mode: 'full',
      generation: plan.generation,
    };
  }

  return {
    type: 'push-messages',
    agentId,
    messages: plan.messages,
    mode: plan.mode,
    baseCount: plan.baseCount!,
    generation: plan.generation!,
  };
}
