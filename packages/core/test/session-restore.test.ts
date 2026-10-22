import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Agent } from '../src/core/agent.js';
import { FileSessionStore } from '../src/core/session-store.js';
import type { AgentFeature } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

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

describe('FileSessionStore atomic write', () => {
  it('saves concurrent snapshots of one session in submission order across store instances', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-session-concurrent-'));
    try {
      const stores = [new FileSessionStore(sessionDir), new FileSessionStore(sessionDir)];
      const snapshots = Array.from({ length: 32 }, (_, callIndex) => ({
        version: 3,
        sessionId: 'concurrent-demo',
        savedAt: callIndex,
        agentType: 'TestAgent',
        runtime: { initialized: true, callIndex, featureStates: [] },
        rollbackHistory: [],
      }));
      const results = await Promise.allSettled(snapshots.map((snapshot, index) =>
        stores[index % stores.length].save(snapshot.sessionId, snapshot)
      ));

      expect(results.map(result => result.status)).toEqual(snapshots.map(() => 'fulfilled'));
      expect(await stores[0].load('concurrent-demo')).toEqual(snapshots.at(-1));
      expect(await readdir(sessionDir)).toEqual(['concurrent-demo.json']);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('reports a failed save without blocking the next snapshot of the same session', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-session-failed-save-'));
    try {
      const store = new FileSessionStore(sessionDir);
      const snapshot = {
        version: 3,
        sessionId: 'recover-demo',
        savedAt: 1,
        agentType: 'TestAgent',
        runtime: { initialized: true, callIndex: 1, featureStates: [] },
        rollbackHistory: [],
      };
      const failure = new Error('snapshot serialization failed');
      const invalid = { ...snapshot, toJSON: () => { throw failure; } };
      const results = await Promise.allSettled([
        store.save(snapshot.sessionId, invalid),
        store.save(snapshot.sessionId, snapshot),
      ]);

      expect(results[0]).toEqual({ status: 'rejected', reason: failure });
      expect(results[1].status).toBe('fulfilled');
      expect(await store.load(snapshot.sessionId)).toEqual(snapshot);
      await store.save(snapshot.sessionId, { ...snapshot, savedAt: 2 });
      expect((await store.load(snapshot.sessionId)).savedAt).toBe(2);
      expect(await readdir(sessionDir)).toEqual(['recover-demo.json']);
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('persists via tmp + rename and leaves no .tmp residue', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-session-'));
    const store = new FileSessionStore(sessionDir);
    const sessionId = 'atomic-demo';

    const snapshot: any = {
      version: 3,
      sessionId,
      savedAt: Date.now(),
      agentType: 'TestAgent',
      runtime: { initialized: true, callIndex: 0, featureStates: [] },
      rollbackHistory: [],
    };

    await store.save(sessionId, snapshot);

    const loaded = await store.load(sessionId);
    expect(loaded.sessionId).toBe(sessionId);
    expect(loaded).toEqual(snapshot);

    const files = await readdir(sessionDir);
    expect(files).toContain(`${sessionId}.json`);
    expect(files.filter(name => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it('overwrites an existing session atomically', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-session-'));
    const store = new FileSessionStore(sessionDir);
    const sessionId = 'overwrite-demo';

    const base = (callIndex: number) => ({
      version: 3,
      sessionId,
      savedAt: Date.now(),
      agentType: 'TestAgent',
      runtime: { initialized: true, callIndex, featureStates: [] },
      rollbackHistory: [],
    });

    await store.save(sessionId, base(1));
    await store.save(sessionId, base(2));

    const loaded = await store.load(sessionId);
    expect(loaded.runtime.callIndex).toBe(2);

    const files = await readdir(sessionDir);
    expect(files.filter(name => name.endsWith('.tmp'))).toHaveLength(0);
  });
});
