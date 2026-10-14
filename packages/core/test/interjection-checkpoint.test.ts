import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

class InterjectionLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
    return { content: `reply:${lastUser}` };
  }
}

/**
 * 插话锚点（captureInterjectionCheckpoint）回归测试。
 *
 * 场景：busy 排队消息在 call 内注入点前必须建立独立回退锚点，否则
 * 「回退到插话」只能匹配轮首 checkpoint，表现为整轮从头回退。
 * 锚点 callIndex 取 N+1-2^-k 二分序列（N.5、N.75…），保证与轮首（N）
 * 及后续轮（N+1）严格可序，同轮多次插话各得唯一锚点。
 */
class InterjectionAgent extends Agent {
  constructor() {
    super({
      llm: new InterjectionLLM(),
      maxTurns: 2,
      name: 'InterjectionAgent',
      systemMessage: 'interjection checkpoint test',
    });
  }
}

describe('interjection rollback anchor', () => {
  it('rollback to interjection anchor keeps the enclosing turn content', async () => {
    const agent = new InterjectionAgent();
    await agent.onCall('turn-one');

    // 模拟 react-loop 排队注入：注入前建锚点，消息 turn 用锚点 callIndex
    const context = agent.getContext();
    const anchorTurn = await agent.captureInterjectionCheckpoint('interject-one', context);
    context.addUserMessage('interject-one', anchorTurn);
    expect(anchorTurn).toBe(0.5);

    // 插话后的轮内产物（assistant 回复）
    context.addAssistantMessage({ content: 'reply-after-interject' } as never, 0);

    const beforeUsers = context.getAll().filter(m => m.role === 'user').map(m => m.content);
    expect(beforeUsers).toEqual(['turn-one', 'interject-one']);

    // 回退到插话锚点：保留轮首内容，仅移除插话及其后
    const rollback = await agent.rollbackToCall(anchorTurn);
    expect(rollback.draftInput).toBe('interject-one');
    const afterUsers = context.getAll().filter(m => m.role === 'user').map(m => m.content);
    expect(afterUsers).toEqual(['turn-one']);

    // 轮首 checkpoint 仍在：可继续回退到整轮之前
    const rollbackHead = await agent.rollbackToCall(0);
    expect(rollbackHead.draftInput).toBe('turn-one');
    expect(context.getAll().filter(m => m.role === 'user')).toHaveLength(0);
  });

  it('multiple interjections in one turn get unique ordered anchors', async () => {
    const agent = new InterjectionAgent();
    await agent.onCall('turn-one');

    const context = agent.getContext();
    const first = await agent.captureInterjectionCheckpoint('interject-a', context);
    context.addUserMessage('interject-a', first);
    const second = await agent.captureInterjectionCheckpoint('interject-b', context);
    context.addUserMessage('interject-b', second);

    expect(first).toBe(0.5);
    expect(second).toBe(0.75);

    // 回退到第二个插话：第一个插话保留
    await agent.rollbackToCall(second);
    let users = context.getAll().filter(m => m.role === 'user').map(m => m.content);
    expect(users).toEqual(['turn-one', 'interject-a']);

    // 回退到第一个插话：两个插话都移除，轮首仍在
    await agent.rollbackToCall(first);
    users = context.getAll().filter(m => m.role === 'user').map(m => m.content);
    expect(users).toEqual(['turn-one']);
  });

  it('interjection anchor does not collide with the next turn checkpoint', async () => {
    const agent = new InterjectionAgent();
    await agent.onCall('turn-one');

    const context = agent.getContext();
    const anchor = await agent.captureInterjectionCheckpoint('interject-a', context);
    context.addUserMessage('interject-a', anchor);

    // 下一轮正常 call（checkpoint callIndex=1，须与锚点 N.5 不冲突）
    await agent.onCall('turn-two');

    // 回退到下一轮：插话与轮首都保留
    await agent.rollbackToCall(1);
    const users = context.getAll().filter(m => m.role === 'user').map(m => m.content);
    expect(users).toEqual(['turn-one', 'interject-a']);
  });
});
