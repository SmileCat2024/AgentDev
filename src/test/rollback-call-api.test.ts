import { describe, it, expect } from 'vitest';
import { Agent } from '../core/agent.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

class RollbackCallLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
    if (lastUser === 'first') {
      return { content: 'first reply' };
    }
    if (lastUser === 'second') {
      return { content: 'second reply' };
    }
    if (lastUser === 'second edited') {
      return { content: 'second edited reply' };
    }
    return { content: 'unexpected state' };
  }
}

class RollbackCallFeature implements AgentFeature {
  readonly name = 'rollback-call-feature';
  counter = 0;

  captureState(): { counter: number } {
    return { counter: this.counter };
  }

  restoreState(snapshot: { counter: number }): void {
    this.counter = snapshot.counter;
  }
}

class RollbackCallAgent extends Agent {
  constructor(private readonly rollbackFeature: RollbackCallFeature) {
    super({
      llm: new RollbackCallLLM(),
      maxTurns: 2,
      name: 'RollbackCallAgent',
      systemMessage: 'rollback api test',
    });
    this.use(rollbackFeature);
  }
}

describe('rollbackToCall API', () => {
  it('should restore context to before the target call and allow re-branching', async () => {
    const agent = new RollbackCallAgent(new RollbackCallFeature());
    const first = await agent.onCall('first');
    const second = await agent.onCall('second');

    expect(first).toBe('first reply');
    expect(second).toBe('second reply');
    expect(agent.getContext().getAll().filter(message => message.role === 'user')).toHaveLength(2);

    const rollback = await agent.rollbackToCall(1);
    expect(rollback.draftInput).toBe('second');
    expect(agent.getContext().getAll().filter(message => message.role === 'user')).toHaveLength(1);

    const resumed = await agent.onCall('second edited');
    expect(resumed).toBe('second edited reply');
    expect(agent.getContext().getAll().filter(message => message.role === 'user')).toHaveLength(2);
  });
});
