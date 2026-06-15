/**
 * Named Checkpoint 测试
 *
 * 验证：
 * 1. 创建命名检查点后可通过 ID 查找
 * 2. 重复 ID 被拒绝
 * 3. 回退到检查点恢复 runtime snapshot
 * 4. 回退后剪除后续检查点
 * 5. 不存在的 ID 抛异常
 * 6. session snapshot 包含命名检查点
 * 7. session restore 恢复命名检查点
 * 8. Feature 状态被正确快照和恢复
 */

import { Agent } from '../core/agent.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';
import type { NamedCheckpoint } from '../core/session-store.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

// ========== 测试用例 ==========

async function testCreateNamedCheckpoint(): Promise<void> {
  const feature = new StatefulFeature();
  const agent = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name: 'CPAgent' });
      this.use(feature);
    }
  })();

  // 执行一次 onCall 以初始化 agent
  await agent.onCall('init');

  // 修改 feature 状态
  feature.stateValue = 42;

  // 创建命名检查点
  const cp = await agent.createNamedCheckpoint('cp-1');
  assert(cp.id === 'cp-1', 'checkpoint id should match');
  assert(cp.sourceCallIndex === 0, 'sourceCallIndex should be 0');
  assert(cp.createdAt > 0, 'createdAt should be positive');

  // 验证可以通过 getNamedCheckpoints 查找
  const checkpoints = agent.getNamedCheckpoints();
  assert(checkpoints.length === 1, 'should have 1 named checkpoint');
  assert(checkpoints[0].id === 'cp-1', 'checkpoint id should match');

  console.log('[PASS] Named checkpoint creation: ID, callIndex, accessible');
}

async function testDuplicateIdRejected(): Promise<void> {
  const agent = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name: 'CPAgent2' });
    }
  })();

  await agent.onCall('init');

  await agent.createNamedCheckpoint('cp-1');

  let threw = false;
  try {
    await agent.createNamedCheckpoint('cp-1');
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes('already exists'), 'should throw "already exists"');
  }
  assert(threw, 'duplicate checkpoint ID should throw');

  console.log('[PASS] Duplicate checkpoint ID rejected');
}

async function testRollbackToNamedCheckpoint(): Promise<void> {
  const feature = new StatefulFeature();
  const agent = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name: 'RollbackAgent' });
      this.use(feature);
    }
  })();

  await agent.onCall('init');

  // Set state to 10 and checkpoint
  feature.stateValue = 10;
  await agent.createNamedCheckpoint('cp-base');

  // Change state to 99
  feature.stateValue = 99;

  // Rollback
  await agent.rollbackToNamedCheckpoint('cp-base');

  // Feature state should be restored to 10
  assert(feature.stateValue === 10, `feature state should be 10 after rollback, got ${feature.stateValue}`);

  console.log('[PASS] Rollback restores feature state');
}

async function testRollbackPrunesFutureCheckpoints(): Promise<void> {
  const feature = new StatefulFeature();
  const agent = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name: 'PruneAgent' });
      this.use(feature);
    }
  })();

  await agent.onCall('init');

  feature.stateValue = 1;
  await agent.createNamedCheckpoint('cp-a');

  feature.stateValue = 2;
  await agent.createNamedCheckpoint('cp-b');

  feature.stateValue = 3;
  await agent.createNamedCheckpoint('cp-c');

  // Verify 3 checkpoints
  assert(agent.getNamedCheckpoints().length === 3, 'should have 3 checkpoints');

  // Rollback to cp-b (should prune cp-c)
  await agent.rollbackToNamedCheckpoint('cp-b');

  // cp-c should be pruned, cp-a and cp-b should remain
  const remaining = agent.getNamedCheckpoints();
  assert(remaining.length === 2, `should have 2 checkpoints after rollback, got ${remaining.length}`);
  assert(remaining.some(cp => cp.id === 'cp-a'), 'cp-a should remain');
  assert(remaining.some(cp => cp.id === 'cp-b'), 'cp-b should remain');
  assert(!remaining.some(cp => cp.id === 'cp-c'), 'cp-c should be pruned');

  // Feature state should be restored to 2 (cp-b's value)
  assert(feature.stateValue === 2, `feature state should be 2, got ${feature.stateValue}`);

  console.log('[PASS] Rollback prunes future checkpoints');
}

async function testNonExistentCheckpointThrows(): Promise<void> {
  const agent = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name: 'ThrowAgent' });
    }
  })();

  await agent.onCall('init');

  let threw = false;
  try {
    await agent.rollbackToNamedCheckpoint('does-not-exist');
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes('not found'), 'should throw "not found"');
  }
  assert(threw, 'non-existent checkpoint should throw');

  console.log('[PASS] Non-existent checkpoint ID throws');
}

async function testSessionSnapshotIncludesCheckpoints(): Promise<void> {
  const feature = new StatefulFeature();
  const agent = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name: 'SnapshotAgent' });
      this.use(feature);
    }
  })();

  await agent.onCall('init');

  feature.stateValue = 77;
  await agent.createNamedCheckpoint('cp-snap');

  const snapshot = await agent.createSessionSnapshot('test-session');

  assert(snapshot.namedCheckpoints !== undefined, 'snapshot should include namedCheckpoints');
  assert(snapshot.namedCheckpoints!.length === 1, 'should have 1 checkpoint in snapshot');
  assert(snapshot.namedCheckpoints![0].id === 'cp-snap', 'checkpoint id should match');

  console.log('[PASS] Session snapshot includes named checkpoints');
}

async function testSessionRestoreIncludesCheckpoints(): Promise<void> {
  const feature = new StatefulFeature();
  const agent = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name: 'RestoreAgent' });
      this.use(feature);
    }
  })();

  await agent.onCall('init');

  feature.stateValue = 55;
  await agent.createNamedCheckpoint('cp-restore-1');
  feature.stateValue = 88;
  await agent.createNamedCheckpoint('cp-restore-2');

  const snapshot = await agent.createSessionSnapshot('restore-test');

  // Create a fresh agent and restore
  const feature2 = new StatefulFeature();
  const agent2 = new (class extends Agent {
    constructor() {
      super({ llm: new DummyLLM(), maxTurns: 1, name: 'RestoreAgent2' });
      this.use(feature2);
    }
  })();

  await agent2.restoreSessionSnapshot(snapshot);

  const restored = agent2.getNamedCheckpoints();
  assert(restored.length === 2, `should have 2 restored checkpoints, got ${restored.length}`);
  assert(restored.some(cp => cp.id === 'cp-restore-1'), 'cp-restore-1 should be restored');
  assert(restored.some(cp => cp.id === 'cp-restore-2'), 'cp-restore-2 should be restored');

  console.log('[PASS] Session restore includes named checkpoints');
}

async function testLegacySnapshotCompat(): Promise<void> {
  // 没有 namedCheckpoints 字段的旧版 snapshot 应该正常恢复
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
    // 注意：没有 namedCheckpoints 字段
  };

  await agent.restoreSessionSnapshot(legacySnapshot as any);

  assert(agent.getNamedCheckpoints().length === 0, 'legacy snapshot should result in 0 named checkpoints');

  console.log('[PASS] Legacy snapshot without namedCheckpoints restores cleanly');
}

async function main(): Promise<void> {
  await testCreateNamedCheckpoint();
  await testDuplicateIdRejected();
  await testRollbackToNamedCheckpoint();
  await testRollbackPrunesFutureCheckpoints();
  await testNonExistentCheckpointThrows();
  await testSessionSnapshotIncludesCheckpoints();
  await testSessionRestoreIncludesCheckpoints();
  await testLegacySnapshotCompat();

  console.log('\nAll named checkpoint tests passed.');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
