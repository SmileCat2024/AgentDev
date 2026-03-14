import { Agent } from '../core/agent.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

async function testRollbackToCall(): Promise<void> {
  const agent = new RollbackCallAgent(new RollbackCallFeature());
  const first = await agent.onCall('first');
  const second = await agent.onCall('second');

  assert(first === 'first reply', 'first call should complete');
  assert(second === 'second reply', 'second call should complete');
  assert(agent.getContext().getAll().filter(message => message.role === 'user').length === 2, 'context should contain two user turns before rollback');

  const rollback = await agent.rollbackToCall(1);
  assert(rollback.draftInput === 'second', 'rollback should return the target user input as draft');
  assert(agent.getContext().getAll().filter(message => message.role === 'user').length === 1, 'rollback should restore context to before the target call');

  const resumed = await agent.onCall('second edited');
  assert(resumed === 'second edited reply', 'agent should continue from the restored branch');
  assert(agent.getContext().getAll().filter(message => message.role === 'user').length === 2, 'new branch should contain edited second input');
}

await testRollbackToCall();
console.log('Rollback call API tests passed');
