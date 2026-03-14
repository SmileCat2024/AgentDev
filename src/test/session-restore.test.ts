import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Agent } from '../core/agent.js';
import { FileSessionStore } from '../core/session-store.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class ResumeLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
    const hasMutateResult = messages.some(message =>
      message.role === 'tool' && message.toolCallId === 'tool_resume_1'
    );

    if (lastUser === 'first' && !hasMutateResult) {
      return {
        content: '先执行一次状态变更。',
        toolCalls: [
          {
            id: 'tool_resume_1',
            name: 'mutate_state',
            arguments: {},
          },
        ],
      };
    }

    if (lastUser === 'first' && hasMutateResult) {
      return { content: 'first done' };
    }

    if (lastUser === 'second') {
      const userCount = messages.filter(message => message.role === 'user').length;
      return { content: `restored-users:${userCount}` };
    }

    return { content: 'unexpected state' };
  }
}

class SessionFeature implements AgentFeature {
  readonly name = 'session-feature';
  counter = 0;
  initiateCount = 0;

  getTools(): Tool[] {
    return [
      {
        name: 'mutate_state',
        description: 'Mutates state for session restore test',
        execute: async () => {
          this.counter += 1;
          return 'counter incremented';
        },
      },
    ];
  }

  async onInitiate(): Promise<void> {
    this.initiateCount += 1;
  }

  captureState(): { counter: number } {
    return { counter: this.counter };
  }

  restoreState(snapshot: { counter: number }): void {
    this.counter = snapshot.counter;
  }
}

class SessionAgent extends Agent {
  constructor(private readonly sessionFeature: SessionFeature) {
    super({
      llm: new ResumeLLM(),
      maxTurns: 4,
      name: 'SessionAgent',
      systemMessage: '你是恢复测试 agent。',
    });
    this.use(sessionFeature);
  }

  getFeatureState(): SessionFeature {
    return this.sessionFeature;
  }
}

async function testSessionRestore(): Promise<void> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-session-'));
  const store = new FileSessionStore(sessionDir);
  const sessionId = 'restore-demo';

  const agent1Feature = new SessionFeature();
  const agent1 = new SessionAgent(agent1Feature);
  const firstResult = await agent1.onCall('first');

  assert(firstResult === 'first done', 'first call should finish naturally');
  assert(agent1Feature.counter === 1, 'first session should mutate feature state');

  await agent1.saveSession(sessionId, store);

  const agent2Feature = new SessionFeature();
  const agent2 = new SessionAgent(agent2Feature);
  await agent2.loadSession(sessionId, store);

  assert(agent2Feature.counter === 1, 'restored session should recover feature state');
  assert(agent2Feature.initiateCount === 1, 'feature resources should be initialized exactly once on restore');
  assert(agent2.getContext().getAll().filter(message => message.role === 'system').length === 1, 'restored context should preserve a single system message');

  const resumedResult = await agent2.onCall('second');
  assert(resumedResult === 'restored-users:2', 'resumed call should continue from restored context');
  assert(agent2.getContext().getAll().filter(message => message.role === 'system').length === 1, 'restored call should not duplicate system message');
  assert(agent2Feature.initiateCount === 1, 'restored session should not re-run feature initiate on resumed calls');
}

await testSessionRestore();
console.log('Session restore tests passed');
