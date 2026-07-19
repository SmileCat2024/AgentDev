import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Agent } from '../core/agent.js';
import { FileSessionStore } from '../core/session-store.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

// ========== Test helpers ==========

class EchoLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    return { content: `reply:${lastUser}` };
  }
}

class CounterFeature implements AgentFeature {
  readonly name = 'counter-feature';
  counter = 0;

  getTools(): Tool[] {
    return [
      {
        name: 'increment',
        description: 'Increment counter',
        execute: async () => {
          this.counter += 1;
          return `counter:${this.counter}`;
        },
      },
    ];
  }

  captureState(): { counter: number } {
    return { counter: this.counter };
  }

  restoreState(snapshot: { counter: number }): void {
    this.counter = snapshot.counter;
  }
}

class TestAgent extends Agent {
  constructor(feature: CounterFeature) {
    super({
      llm: new EchoLLM(),
      maxTurns: 2,
      name: 'V2TestAgent',
      systemMessage: 'v2 rollback test',
    });
    this.use(feature);
  }
}

// ========== Tests ==========

describe('V2 incremental rollback', () => {

  describe('checkpoint format', () => {
    it('should create context-boundary checkpoints after onCall', async () => {
      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.onCall('hello');

      const checkpoints = (agent as any)._callCheckpoints as any[];
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].kind).toBe('context-boundary');
      expect(checkpoints[0].contextBoundary).toBeDefined();
      expect(checkpoints[0].contextBoundary.messagesLength).toBe(1); // system prompt
      expect(checkpoints[0].contextBoundary.generation).toBe(0);
      expect(checkpoints[0].runtimeState).toBeDefined();
      expect(checkpoints[0].runtimeState.initialized).toBe(true);
    });

    it('should not embed full context in boundary checkpoint', async () => {
      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.onCall('hello');

      const checkpoints = (agent as any)._callCheckpoints as any[];
      expect(checkpoints[0].runtime).toBeUndefined();
      expect(checkpoints[0].context).toBeUndefined();
    });
  });

  describe('rollbackToCall with boundary', () => {
    it('should truncate context and restore feature state', async () => {
      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.onCall('first');
      await agent.onCall('second');

      expect(feature.counter).toBe(0);
      expect(agent.getContext().getAll().filter(m => m.role === 'user')).toHaveLength(2);

      // rollbackToCall(1) = roll back to before the second call (callIndex starts at 0)
      const rollback = await agent.rollbackToCall(1);
      expect(rollback.draftInput).toBe('second');
      expect(agent.getContext().getAll().filter(m => m.role === 'user')).toHaveLength(1);

      // rollbackToCall(0) = roll back to before the first call
      await agent.rollbackToCall(0);
      const messages = agent.getContext().getAll();
      expect(messages.every(m => m.role !== 'user')).toBe(true);
    });

    it('should support re-branching after rollback', async () => {
      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.onCall('first');
      await agent.onCall('second');

      await agent.rollbackToCall(1);
      const resumed = await agent.onCall('edited');
      expect(resumed).toBe('reply:edited');
    });

    it('should handle multiple rollbacks', async () => {
      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.onCall('a');
      await agent.onCall('b');
      await agent.onCall('c');

      // Roll back to before call c (callIndex 2)
      await agent.rollbackToCall(2);
      expect(agent.getContext().getAll().filter(m => m.role === 'user')).toHaveLength(2);

      // Roll back to before call b (callIndex 1)
      await agent.rollbackToCall(1);
      expect(agent.getContext().getAll().filter(m => m.role === 'user')).toHaveLength(1);
    });
  });

  describe('session serialization v2', () => {
    it('should output version 2 with boundary checkpoints', async () => {
      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.onCall('first');
      await agent.onCall('second');

      const snapshot = await agent.createSessionSnapshot('test-session');
      expect(snapshot.version).toBe(2);
      expect(snapshot.rollbackHistory).toHaveLength(2);
      expect(snapshot.rollbackHistory[0].kind).toBe('context-boundary');
      expect(snapshot.rollbackHistory[1].kind).toBe('context-boundary');
      // Current runtime still has full context
      expect(snapshot.runtime.context).toBeDefined();
      expect(snapshot.runtime.context!.messages.length).toBeGreaterThan(0);
    });

    it('should round-trip: save v2 → load v2 → rollback works', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-v2-'));
      const store = new FileSessionStore(sessionDir);
      const sessionId = 'v2-roundtrip';

      const feature1 = new CounterFeature();
      const agent1 = new TestAgent(feature1);
      await agent1.onCall('first');
      await agent1.onCall('second');

      await agent1.saveSession(sessionId, store);

      // Load in new agent
      const feature2 = new CounterFeature();
      const agent2 = new TestAgent(feature2);
      await agent2.loadSession(sessionId, store);

      // Checkpoints should be boundary-based
      const checkpoints = (agent2 as any)._callCheckpoints as any[];
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0].kind).toBe('context-boundary');

      // Rollback should work (rollbackToCall(1) = before second call)
      await agent2.rollbackToCall(1);
      expect(agent2.getContext().getAll().filter(m => m.role === 'user')).toHaveLength(1);

      // Re-branch
      const result = await agent2.onCall('rebranched');
      expect(result).toBe('reply:rebranched');
    });

    it('should preserve generation across save/load cycle', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-v2-'));
      const store = new FileSessionStore(sessionDir);
      const sessionId = 'v2-gen';

      const feature1 = new CounterFeature();
      const agent1 = new TestAgent(feature1);
      await agent1.onCall('first');
      await agent1.saveSession(sessionId, store);

      const feature2 = new CounterFeature();
      const agent2 = new TestAgent(feature2);
      await agent2.loadSession(sessionId, store);

      // After load, context generation should match boundary generation
      const checkpoints = (agent2 as any)._callCheckpoints as any[];
      const ctxGen = agent2.getContext().captureBoundary().generation;
      expect(checkpoints[0].contextBoundary.generation).toBe(ctxGen);
    });
  });

  describe('v1 lazy migration', () => {
    it('should migrate v1 checkpoints to boundary on load', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-v1-migrate-'));
      const store = new FileSessionStore(sessionDir);
      const sessionId = 'v1-migrate';

      // Manually construct a v1 session file
      const v1Snapshot = {
        version: 1,
        sessionId,
        savedAt: Date.now(),
        agentType: 'TestAgent',
        runtime: {
          initialized: true,
          callIndex: 2,
          context: {
            version: 2,
            messages: [
              { role: 'system', content: 'v2 rollback test', turn: 0 },
              { role: 'user', content: 'first', turn: 1 },
              { role: 'assistant', content: 'reply:first', turn: 1 },
              { role: 'user', content: 'second', turn: 2 },
              { role: 'assistant', content: 'reply:second', turn: 2 },
            ],
            enrichedMessages: [],
            sequence: 0,
          },
          featureStates: [{ featureName: 'counter-feature', snapshot: { counter: 0 } }],
        },
        rollbackHistory: [
          {
            callIndex: 1,
            draftInput: 'first',
            runtime: {
              initialized: true,
              callIndex: 0,
              context: {
                version: 2,
                messages: [
                  { role: 'system', content: 'v2 rollback test', turn: 0 },
                ],
                enrichedMessages: [],
                sequence: 0,
              },
              featureStates: [],
            },
          },
          {
            callIndex: 2,
            draftInput: 'second',
            runtime: {
              initialized: true,
              callIndex: 1,
              context: {
                version: 2,
                messages: [
                  { role: 'system', content: 'v2 rollback test', turn: 0 },
                  { role: 'user', content: 'first', turn: 1 },
                  { role: 'assistant', content: 'reply:first', turn: 1 },
                ],
                enrichedMessages: [],
                sequence: 0,
              },
              featureStates: [{ featureName: 'counter-feature', snapshot: { counter: 0 } }],
            },
          },
        ],
      };

      await store.save(sessionId, v1Snapshot as any);

      // Load with agent
      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.loadSession(sessionId, store);

      const checkpoints = (agent as any)._callCheckpoints as any[];

      // Both should be migrated to boundary
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0].kind).toBe('context-boundary');
      expect(checkpoints[1].kind).toBe('context-boundary');

      // Boundary lengths should match v1 checkpoint message counts
      expect(checkpoints[0].contextBoundary.messagesLength).toBe(1);
      expect(checkpoints[1].contextBoundary.messagesLength).toBe(3);

      // Generation should match current context
      const ctxGen = agent.getContext().captureBoundary().generation;
      expect(checkpoints[0].contextBoundary.generation).toBe(ctxGen);
    });

    it('should rollback using migrated boundary checkpoints', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-v1-rollback-'));
      const store = new FileSessionStore(sessionDir);
      const sessionId = 'v1-rollback';

      const v1Snapshot = {
        version: 1,
        sessionId,
        savedAt: Date.now(),
        agentType: 'TestAgent',
        runtime: {
          initialized: true,
          callIndex: 2,
          context: {
            version: 2,
            messages: [
              { role: 'system', content: 'v2 rollback test', turn: 0 },
              { role: 'user', content: 'first', turn: 1 },
              { role: 'assistant', content: 'reply:first', turn: 1 },
              { role: 'user', content: 'second', turn: 2 },
              { role: 'assistant', content: 'reply:second', turn: 2 },
            ],
            enrichedMessages: [],
            sequence: 0,
          },
          featureStates: [],
        },
        rollbackHistory: [
          {
            callIndex: 1,
            draftInput: 'first',
            runtime: {
              initialized: true,
              callIndex: 0,
              context: {
                version: 2,
                messages: [{ role: 'system', content: 'v2 rollback test', turn: 0 }],
                enrichedMessages: [],
                sequence: 0,
              },
              featureStates: [],
            },
          },
        ],
      };

      await store.save(sessionId, v1Snapshot as any);

      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.loadSession(sessionId, store);

      // Rollback to call 1 (before 'first' was added)
      const rollback = await agent.rollbackToCall(1);
      expect(rollback.draftInput).toBe('first');

      // Context should be truncated to just system message
      const messages = agent.getContext().getAll();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('system');
    });

    it('should keep non-prefix checkpoints as legacy', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-v1-noprefix-'));
      const store = new FileSessionStore(sessionDir);
      const sessionId = 'v1-noprefix';

      // v1 session where a checkpoint has completely different content
      // (simulating a corrupted or cross-lineage checkpoint)
      const v1Snapshot = {
        version: 1,
        sessionId,
        savedAt: Date.now(),
        agentType: 'TestAgent',
        runtime: {
          initialized: true,
          callIndex: 1,
          context: {
            version: 2,
            messages: [
              { role: 'system', content: 'v2 rollback test', turn: 0 },
              { role: 'user', content: 'first', turn: 1 },
              { role: 'assistant', content: 'reply:first', turn: 1 },
            ],
            enrichedMessages: [],
            sequence: 0,
          },
          featureStates: [],
        },
        rollbackHistory: [
          {
            callIndex: 1,
            draftInput: 'first',
            runtime: {
              initialized: true,
              callIndex: 0,
              context: {
                version: 2,
                // This checkpoint has MORE messages than current — not a prefix
                messages: [
                  { role: 'system', content: 'v2 rollback test', turn: 0 },
                  { role: 'user', content: 'first', turn: 1 },
                  { role: 'assistant', content: 'reply:first', turn: 1 },
                  { role: 'user', content: 'second', turn: 2 },
                  { role: 'assistant', content: 'reply:second', turn: 2 },
                  { role: 'user', content: 'third', turn: 3 },
                ],
                enrichedMessages: [],
                sequence: 0,
              },
              featureStates: [],
            },
          },
        ],
      };

      await store.save(sessionId, v1Snapshot as any);

      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.loadSession(sessionId, store);

      const checkpoints = (agent as any)._callCheckpoints as any[];
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].kind).toBe('legacy-full-snapshot');
      expect(checkpoints[0].legacyReason).toBeDefined();
    });
  });

  describe('mixed history', () => {
    it('should handle rollback when boundary and legacy checkpoints coexist', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-mixed-'));
      const store = new FileSessionStore(sessionDir);
      const sessionId = 'mixed-test';

      const v1Snapshot = {
        version: 1,
        sessionId,
        savedAt: Date.now(),
        agentType: 'TestAgent',
        runtime: {
          initialized: true,
          callIndex: 2,
          context: {
            version: 2,
            messages: [
              { role: 'system', content: 'v2 rollback test', turn: 0 },
              { role: 'user', content: 'first', turn: 1 },
              { role: 'assistant', content: 'reply:first', turn: 1 },
              { role: 'user', content: 'second', turn: 2 },
              { role: 'assistant', content: 'reply:second', turn: 2 },
            ],
            enrichedMessages: [],
            sequence: 0,
          },
          featureStates: [],
        },
        // callIndex 1 is a valid prefix → migrated to boundary
        // callIndex 2 is NOT a prefix (longer than current) → stays legacy
        rollbackHistory: [
          {
            callIndex: 1,
            draftInput: 'first',
            runtime: {
              initialized: true,
              callIndex: 0,
              context: {
                version: 2,
                messages: [{ role: 'system', content: 'v2 rollback test', turn: 0 }],
                enrichedMessages: [],
                sequence: 0,
              },
              featureStates: [],
            },
          },
          {
            callIndex: 2,
            draftInput: 'second',
            runtime: {
              initialized: true,
              callIndex: 1,
              context: {
                version: 2,
                messages: [
                  { role: 'system', content: 'v2 rollback test', turn: 0 },
                  { role: 'user', content: 'first', turn: 1 },
                  { role: 'assistant', content: 'reply:first', turn: 1 },
                  { role: 'user', content: 'second', turn: 2 },
                  { role: 'assistant', content: 'reply:second', turn: 2 },
                  { role: 'user', content: 'extra', turn: 3 },
                ],
                enrichedMessages: [],
                sequence: 0,
              },
              featureStates: [],
            },
          },
        ],
      };

      await store.save(sessionId, v1Snapshot as any);

      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.loadSession(sessionId, store);

      const checkpoints = (agent as any)._callCheckpoints as any[];
      // callIndex 1 → boundary, callIndex 2 → legacy
      expect(checkpoints[0].kind).toBe('context-boundary');
      expect(checkpoints[1].kind).toBe('legacy-full-snapshot');

      // Rollback to boundary checkpoint (callIndex 1)
      await agent.rollbackToCall(1);
      const messages = agent.getContext().getAll();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('system');
    });
  });

  describe('v1 → v2 upgrade on save', () => {
    it('should write v2 format after loading and saving a v1 session', async () => {
      const sessionDir = await mkdtemp(join(tmpdir(), 'agentdev-upgrade-'));
      const store = new FileSessionStore(sessionDir);
      const sessionId = 'upgrade-test';

      // Write v1 session
      const v1Snapshot = {
        version: 1,
        sessionId,
        savedAt: Date.now(),
        agentType: 'TestAgent',
        runtime: {
          initialized: true,
          callIndex: 1,
          context: {
            version: 2,
            messages: [
              { role: 'system', content: 'v2 rollback test', turn: 0 },
              { role: 'user', content: 'first', turn: 1 },
              { role: 'assistant', content: 'reply:first', turn: 1 },
            ],
            enrichedMessages: [],
            sequence: 0,
          },
          featureStates: [],
        },
        rollbackHistory: [
          {
            callIndex: 1,
            draftInput: 'first',
            runtime: {
              initialized: true,
              callIndex: 0,
              context: {
                version: 2,
                messages: [{ role: 'system', content: 'v2 rollback test', turn: 0 }],
                enrichedMessages: [],
                sequence: 0,
              },
              featureStates: [],
            },
          },
        ],
      };

      await store.save(sessionId, v1Snapshot as any);

      // Load and re-save
      const feature = new CounterFeature();
      const agent = new TestAgent(feature);
      await agent.loadSession(sessionId, store);
      await agent.saveSession(sessionId, store);

      // Read back the raw file to verify version
      const raw = await store.load(sessionId);
      expect(raw.version).toBe(2);
      expect(raw.rollbackHistory[0].kind).toBe('context-boundary');
    });
  });
});
