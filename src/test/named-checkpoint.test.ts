/**
 * Named Checkpoint 测试
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../core/agent.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

// ========== Mock ==========

class DummyLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'ok' };
  }
}

class StatefulFeature implements AgentFeature {
  readonly name = 'stateful-feature';
  stateValue = 0;

  captureState(): { value: number } {
    return { value: this.stateValue };
  }

  restoreState(snapshot: { value: number }): void {
    this.stateValue = snapshot.value;
  }
}

// ========== Helpers ==========

function createStatefulAgent(name: string, feature?: StatefulFeature) {
  const f = feature ?? new StatefulFeature();
  const agent = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name });
      this.use(f);
    }
  })();
  return { agent, feature: f };
}

// ========== 测试用例 ==========

describe('Named Checkpoint', () => {
  it('should create a named checkpoint with correct metadata', async () => {
    const { agent, feature } = createStatefulAgent('CPAgent');
    await agent.onCall('init');

    feature.stateValue = 42;
    const cp = await agent.createNamedCheckpoint('cp-1');

    expect(cp.id).toBe('cp-1');
    expect(cp.sourceCallIndex).toBe(0);
    expect(cp.createdAt).toBeGreaterThan(0);

    const checkpoints = agent.getNamedCheckpoints();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].id).toBe('cp-1');
  });

  it('should reject duplicate checkpoint IDs', async () => {
    const agent = new (class extends Agent {
      constructor() {
        super({ llm: new DummyLLM(), maxTurns: 1, name: 'CPAgent2' });
      }
    })();

    await agent.onCall('init');
    await agent.createNamedCheckpoint('cp-1');

    await expect(agent.createNamedCheckpoint('cp-1')).rejects.toThrow(/already exists/);
  });

  it('should restore feature state on rollback', async () => {
    const { agent, feature } = createStatefulAgent('RollbackAgent');
    await agent.onCall('init');

    feature.stateValue = 10;
    await agent.createNamedCheckpoint('cp-base');
    feature.stateValue = 99;

    await agent.rollbackToNamedCheckpoint('cp-base');

    expect(feature.stateValue).toBe(10);
  });

  it('should prune future checkpoints on rollback', async () => {
    const { agent, feature } = createStatefulAgent('PruneAgent');
    await agent.onCall('init');

    feature.stateValue = 1;
    await agent.createNamedCheckpoint('cp-a');
    feature.stateValue = 2;
    await agent.createNamedCheckpoint('cp-b');
    feature.stateValue = 3;
    await agent.createNamedCheckpoint('cp-c');

    expect(agent.getNamedCheckpoints()).toHaveLength(3);

    await agent.rollbackToNamedCheckpoint('cp-b');

    const remaining = agent.getNamedCheckpoints();
    expect(remaining).toHaveLength(2);
    expect(remaining.some(cp => cp.id === 'cp-a')).toBe(true);
    expect(remaining.some(cp => cp.id === 'cp-b')).toBe(true);
    expect(remaining.some(cp => cp.id === 'cp-c')).toBe(false);
    expect(feature.stateValue).toBe(2);
  });

  it('should throw on non-existent checkpoint ID', async () => {
    const agent = new (class extends Agent {
      constructor() {
        super({ llm: new DummyLLM(), maxTurns: 1, name: 'ThrowAgent' });
      }
    })();
    await agent.onCall('init');

    await expect(agent.rollbackToNamedCheckpoint('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('should include named checkpoints in session snapshot', async () => {
    const { agent, feature } = createStatefulAgent('SnapshotAgent');
    await agent.onCall('init');

    feature.stateValue = 77;
    await agent.createNamedCheckpoint('cp-snap');

    const snapshot = await agent.createSessionSnapshot('test-session');

    expect(snapshot.namedCheckpoints).toBeDefined();
    expect(snapshot.namedCheckpoints).toHaveLength(1);
    expect(snapshot.namedCheckpoints![0].id).toBe('cp-snap');
  });

  it('should restore named checkpoints from session snapshot', async () => {
    const { agent, feature } = createStatefulAgent('RestoreAgent');
    await agent.onCall('init');

    feature.stateValue = 55;
    await agent.createNamedCheckpoint('cp-restore-1');
    feature.stateValue = 88;
    await agent.createNamedCheckpoint('cp-restore-2');

    const snapshot = await agent.createSessionSnapshot('restore-test');

    const feature2 = new StatefulFeature();
    const agent2 = new (class extends Agent {
      constructor() {
        super({ llm: new DummyLLM(), maxTurns: 1, name: 'RestoreAgent2' });
        this.use(feature2);
      }
    })();

    await agent2.restoreSessionSnapshot(snapshot);

    const restored = agent2.getNamedCheckpoints();
    expect(restored).toHaveLength(2);
    expect(restored.some(cp => cp.id === 'cp-restore-1')).toBe(true);
    expect(restored.some(cp => cp.id === 'cp-restore-2')).toBe(true);
  });

  it('should restore legacy snapshots without namedCheckpoints cleanly', async () => {
    const agent = new (class extends Agent {
      constructor() {
        super({ llm: new DummyLLM(), maxTurns: 1, name: 'LegacyAgent' });
      }
    })();

    const legacySnapshot = {
      version: 1,
      sessionId: 'legacy',
      savedAt: Date.now(),
      agentType: 'LegacyAgent',
      runtime: {
        initialized: true,
        callIndex: 0,
        context: undefined,
        featureStates: [],
      },
      rollbackHistory: [],
    };

    await agent.restoreSessionSnapshot(legacySnapshot as any);

    expect(agent.getNamedCheckpoints()).toHaveLength(0);
  });
});
