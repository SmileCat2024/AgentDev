import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Agent } from '../core/agent.js';
import { FileSessionStore } from '../core/session-store.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

class ResumeLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
    const hasMutateResult = messages.some(message =>
      message.role === 'tool' && message.toolCallId === 'tool_resume_1'
    );

    if (lastUser === 'first' && !hasMutateResult) {
      return {
        content: '先执行一次状态变更。',
        toolCalls: [{ id: 'tool_resume_1', name: 'mutate_state', arguments: {} }],
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
}

describe('Session restore', () => {
  it('should restore context and feature state across processes', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-session-'));
    const store = new FileSessionStore(sessionDir);
    const sessionId = 'restore-demo';

    const agent1Feature = new SessionFeature();
    const agent1 = new SessionAgent(agent1Feature);
    const firstResult = await agent1.onCall('first');

    expect(firstResult).toBe('first done');
    expect(agent1Feature.counter).toBe(1);

    await agent1.saveSession(sessionId, store);

    const agent2Feature = new SessionFeature();
    const agent2 = new SessionAgent(agent2Feature);
    await agent2.loadSession(sessionId, store);

    expect(agent2Feature.counter).toBe(1);
    expect(agent2Feature.initiateCount).toBe(1);
    expect(agent2.getContext().getAll().filter(message => message.role === 'system')).toHaveLength(1);

    const resumedResult = await agent2.onCall('second');
    expect(resumedResult).toBe('restored-users:2');
    expect(agent2.getContext().getAll().filter(message => message.role === 'system')).toHaveLength(1);
    expect(agent2Feature.initiateCount).toBe(1);
  });
});
