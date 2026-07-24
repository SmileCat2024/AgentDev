import { describe, it, expect, vi } from 'vitest';

import type {
  CheckpointContinuationRequest,
  RollbackContinuationRequest,
  CallContinuationRequest,
} from '../../core/continuation.js';

import {
  captureFeatureSnapshots,
  restoreFeatureSnapshots,
  createStepCheckpoint,
  rollbackToStepCheckpoint,
} from '../../core/checkpoint.js';
import type { StepCheckpoint, FeatureCheckpoint } from '../../core/checkpoint.js';
import type { AgentFeature, FeatureStateSnapshot } from '../../core/feature.js';
import { Context } from '../../core/context.js';

// ============================================================
// continuation.ts — type-level smoke tests
// ============================================================

describe('continuation types', () => {
  it('CheckpointContinuationRequest should have kind "checkpoint"', () => {
    const req: CheckpointContinuationRequest = {
      kind: 'checkpoint',
      checkpointId: 'cp-1',
    };
    expect(req.kind).toBe('checkpoint');
    expect(req.checkpointId).toBe('cp-1');
    expect(req.metadata).toBeUndefined();
  });

  it('RollbackContinuationRequest should have kind "rollback" with summary', () => {
    const req: RollbackContinuationRequest = {
      kind: 'rollback',
      checkpointId: 'cp-1',
      summary: 'Tool X failed with timeout',
    };
    expect(req.kind).toBe('rollback');
    expect(req.summary).toBe('Tool X failed with timeout');
  });

  it('CallContinuationRequest should be discriminated union', () => {
    const cp: CallContinuationRequest = {
      kind: 'checkpoint',
      checkpointId: 'cp-2',
      metadata: { foo: 'bar' },
    };
    const rb: CallContinuationRequest = {
      kind: 'rollback',
      checkpointId: 'cp-1',
      summary: 'error',
    };

    expect(cp.kind).toBe('checkpoint');
    expect(rb.kind).toBe('rollback');
  });
});

// ============================================================
// Mock Feature helpers
// ============================================================

interface StatefulFeatureData {
  counter: number;
  label: string;
}

class MockStatefulFeature implements AgentFeature {
  readonly name: string;
  counter = 0;
  label = 'initial';
  beforeRollbackCount = 0;
  afterRollbackCount = 0;
  restoreCallCount = 0;

  constructor(name: string) {
    this.name = name;
  }

  captureState(): FeatureStateSnapshot {
    return { counter: this.counter, label: this.label };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const data = snapshot as StatefulFeatureData;
    this.counter = data.counter;
    this.label = data.label;
    this.restoreCallCount++;
  }

  beforeRollback(): void {
    this.beforeRollbackCount++;
  }

  afterRollback(): void {
    this.afterRollbackCount++;
  }
}

class MockNoSnapshotFeature implements AgentFeature {
  readonly name = 'no-snapshot';
  someState = 42;
  // no captureState / restoreState
}

function makeFeatureMap(
  ...features: AgentFeature[]
): Map<string, AgentFeature> {
  const map = new Map<string, AgentFeature>();
  for (const f of features) {
    map.set(f.name, f);
  }
  return map;
}

// ============================================================
// captureFeatureSnapshots
// ============================================================

describe('captureFeatureSnapshots', () => {
  it('should capture all features that have captureState AND restoreState', () => {
    const f1 = new MockStatefulFeature('f1');
    f1.counter = 5;
    f1.label = 'captured';

    const f2 = new MockStatefulFeature('f2');
    f2.counter = 10;

    const features = makeFeatureMap(f1, f2);
    const snapshots = captureFeatureSnapshots(features);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].featureName).toBe('f1');
    expect(snapshots[0].snapshot).toEqual({ counter: 5, label: 'captured' });
    expect(snapshots[1].featureName).toBe('f2');
    expect(snapshots[1].snapshot).toEqual({ counter: 10, label: 'initial' });
  });

  it('should skip features without captureState', () => {
    const noSnapshot = new MockNoSnapshotFeature();
    const features = makeFeatureMap(noSnapshot);
    const snapshots = captureFeatureSnapshots(features);
    expect(snapshots).toEqual([]);
  });

  it('should return empty array when features is undefined', () => {
    const snapshots = captureFeatureSnapshots(undefined);
    expect(snapshots).toEqual([]);
  });

  it('should return empty array when feature map is empty', () => {
    const snapshots = captureFeatureSnapshots(new Map());
    expect(snapshots).toEqual([]);
  });

  it('snapshot should be a deep clone (value semantics)', () => {
    const feature = new MockStatefulFeature('clone');
    feature.counter = 3;
    feature.label = 'original';

    const features = makeFeatureMap(feature);
    const snapshots = captureFeatureSnapshots(features);

    // Mutate original feature after capture
    feature.counter = 999;
    feature.label = 'mutated';

    // Snapshot should NOT reflect the mutation
    expect(snapshots[0].snapshot).toEqual({ counter: 3, label: 'original' });
  });

  it('snapshot with nested object should be deep cloned', () => {
    const feature: AgentFeature = {
      name: 'nested',
      captureState: () => ({ deep: { value: 'before' } }),
      restoreState: () => {},
    };
    const features = makeFeatureMap(feature);
    const snapshots = captureFeatureSnapshots(features);

    // The returned snapshot is already a clone from captureState,
    // but we verify the checkpoint stores a deep copy
    const checkpoint: FeatureCheckpoint = snapshots[0];
    const snapshotData = checkpoint.snapshot as { deep: { value: string } };

    // Mutate the snapshot's nested object
    snapshotData.deep.value = 'after';

    // Original captureState should not be affected (cloneFeatureSnapshot deep copies)
    expect(feature.captureState!()).toEqual({ deep: { value: 'before' } });
  });
});

// ============================================================
// restoreFeatureSnapshots
// ============================================================

describe('restoreFeatureSnapshots', () => {
  it('should call feature.restoreState with cloned snapshot', async () => {
    const feature = new MockStatefulFeature('restore');
    feature.counter = 100;
    feature.label = 'current';

    const features = makeFeatureMap(feature);
    const snapshots = captureFeatureSnapshots(features);

    // Mutate feature before restore
    feature.counter = 0;
    feature.label = 'changed';

    await restoreFeatureSnapshots(snapshots, features);

    expect(feature.counter).toBe(100);
    expect(feature.label).toBe('current');
  });

  it('should call beforeEach and afterEach hooks', async () => {
    const feature = new MockStatefulFeature('hooks');
    const features = makeFeatureMap(feature);
    const snapshots = captureFeatureSnapshots(features);

    const beforeSpy = vi.fn();
    const afterSpy = vi.fn();

    await restoreFeatureSnapshots(snapshots, features, {
      beforeEach: beforeSpy,
      afterEach: afterSpy,
    });

    expect(beforeSpy).toHaveBeenCalledTimes(1);
    expect(beforeSpy).toHaveBeenCalledWith(feature, expect.any(Object));
    expect(afterSpy).toHaveBeenCalledTimes(1);
    expect(afterSpy).toHaveBeenCalledWith(feature, expect.any(Object));
  });

  it('should safely skip features not in the map', async () => {
    const snapshots: FeatureCheckpoint[] = [
      { featureName: 'nonexistent', snapshot: { foo: 1 } },
    ];
    // Should not throw
    await restoreFeatureSnapshots(snapshots, new Map());
  });

  it('should safely skip snapshots for features without restoreState', async () => {
    const noRestore: AgentFeature = {
      name: 'no-restore',
      captureState: () => ({ val: 1 }),
      // no restoreState
    };
    const features = makeFeatureMap(noRestore);
    const snapshots: FeatureCheckpoint[] = [
      { featureName: 'no-restore', snapshot: { val: 1 } },
    ];
    // Should not throw
    await restoreFeatureSnapshots(snapshots, features);
  });

  it('should work when features map is undefined (empty)', async () => {
    const snapshots: FeatureCheckpoint[] = [
      { featureName: 'x', snapshot: {} },
    ];
    await restoreFeatureSnapshots(snapshots, undefined);
    // no throw
  });

  it('should pass a deep-cloned snapshot (independent from checkpoint source)', async () => {
    const originalSnapshot = { nested: { value: 'original' } };
    let restoreReceivedSnapshot: any;

    const feature: AgentFeature = {
      name: 'deep',
      captureState: () => originalSnapshot,
      restoreState: (s) => { restoreReceivedSnapshot = s; },
    };
    const features = makeFeatureMap(feature);

    const snapshots: FeatureCheckpoint[] = [
      { featureName: 'deep', snapshot: originalSnapshot },
    ];

    await restoreFeatureSnapshots(snapshots, features);

    // Mutate the restoreState-received snapshot
    restoreReceivedSnapshot.nested.value = 'mutated';

    // The checkpoint source snapshot should not be affected (cloneFeatureSnapshot deep copies)
    expect(originalSnapshot.nested.value).toBe('original');
  });
});

// ============================================================
// createStepCheckpoint
// ============================================================

describe('createStepCheckpoint', () => {
  it('should capture both context and feature snapshots', () => {
    const ctx = new Context();
    ctx.add({ role: 'user', content: 'hello' });

    const feature = new MockStatefulFeature('feat');
    feature.counter = 7;

    const features = makeFeatureMap(feature);
    const checkpoint = createStepCheckpoint(ctx, features);

    expect(checkpoint.context).toBeDefined();
    expect(checkpoint.context.messages).toHaveLength(1);
    expect(checkpoint.context.messages[0].role).toBe('user');
    expect(checkpoint.features).toHaveLength(1);
    expect(checkpoint.features[0].featureName).toBe('feat');
    expect(checkpoint.features[0].snapshot).toEqual({ counter: 7, label: 'initial' });
  });

  it('should work with context only (no features)', () => {
    const ctx = new Context();
    ctx.add({ role: 'assistant', content: 'response' });

    const checkpoint = createStepCheckpoint(ctx);
    expect(checkpoint.context.messages).toHaveLength(1);
    expect(checkpoint.features).toEqual([]);
  });

  it('should produce a context snapshot that is independent of the original', () => {
    const ctx = new Context();
    ctx.add({ role: 'user', content: 'message A' });

    const checkpoint = createStepCheckpoint(ctx);

    // Mutate context after checkpoint
    ctx.add({ role: 'user', content: 'message B' });

    // Checkpoint should still have only 1 message
    expect(checkpoint.context.messages).toHaveLength(1);
    expect(checkpoint.context.messages[0].content).toBe('message A');
  });
});

// ============================================================
// rollbackToStepCheckpoint
// ============================================================

describe('rollbackToStepCheckpoint', () => {
  it('should restore features before context', async () => {
    const ctx = new Context();
    ctx.add({ role: 'user', content: 'original' });

    const feature = new MockStatefulFeature('feat');
    feature.counter = 5;

    const features = makeFeatureMap(feature);
    const checkpoint = createStepCheckpoint(ctx, features);

    // Mutate state
    ctx.add({ role: 'user', content: 'extra' });
    feature.counter = 999;

    await rollbackToStepCheckpoint(checkpoint, ctx, features);

    // Context restored
    expect(ctx.toJSON().messages).toHaveLength(1);
    expect(ctx.toJSON().messages[0].content).toBe('original');

    // Feature restored
    expect(feature.counter).toBe(5);
  });

  it('should call beforeRollback and afterRollback on features', async () => {
    const feature = new MockStatefulFeature('feat');
    const features = makeFeatureMap(feature);
    const ctx = new Context();
    const checkpoint = createStepCheckpoint(ctx, features);

    await rollbackToStepCheckpoint(checkpoint, ctx, features);

    expect(feature.beforeRollbackCount).toBe(1);
    expect(feature.afterRollbackCount).toBe(1);
  });

  it('should restore context correctly after rollback', async () => {
    const ctx = new Context();
    ctx.add({ role: 'user', content: 'msg1' });
    ctx.add({ role: 'assistant', content: 'reply1' });

    const checkpoint = createStepCheckpoint(ctx);

    ctx.add({ role: 'user', content: 'msg2' });
    ctx.add({ role: 'assistant', content: 'reply2' });

    await rollbackToStepCheckpoint(checkpoint, ctx);

    const snapshot = ctx.toJSON();
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0].content).toBe('msg1');
    expect(snapshot.messages[1].content).toBe('reply1');
  });

  it('should handle checkpoint with no features', async () => {
    const ctx = new Context();
    ctx.add({ role: 'user', content: 'keep' });

    const checkpoint: StepCheckpoint = {
      context: ctx.toJSON(),
      features: [],
    };

    ctx.add({ role: 'user', content: 'remove' });
    await rollbackToStepCheckpoint(checkpoint, ctx);

    expect(ctx.toJSON().messages).toHaveLength(1);
    expect(ctx.toJSON().messages[0].content).toBe('keep');
  });

  it('should not call hooks on features not in map during rollback', async () => {
    const feature = new MockStatefulFeature('feat');
    const ctx = new Context();
    const features = makeFeatureMap(feature);

    // Create checkpoint with the feature
    const checkpoint = createStepCheckpoint(ctx, features);

    // Rollback without the feature in the map
    await rollbackToStepCheckpoint(checkpoint, ctx, new Map());

    // Feature hooks should not have been called during rollback
    expect(feature.beforeRollbackCount).toBe(0);
    expect(feature.afterRollbackCount).toBe(0);
  });
});

// ============================================================
// Value snapshot semantics (CLAUDE.md Contract #15)
// ============================================================

describe('value snapshot semantics (CLAUDE.md #15)', () => {
  it('modifying original feature state after capture should not affect saved checkpoint', () => {
    const feature = new MockStatefulFeature('vs');
    feature.counter = 42;
    feature.label = 'before';

    const ctx = new Context();
    const features = makeFeatureMap(feature);

    const checkpoint = createStepCheckpoint(ctx, features);

    // Mutate after checkpoint
    feature.counter = 0;
    feature.label = 'after';

    // Checkpoint snapshot is unaffected
    const snap = checkpoint.features[0].snapshot as StatefulFeatureData;
    expect(snap.counter).toBe(42);
    expect(snap.label).toBe('before');
  });

  it('modifying restored snapshot should not affect the checkpoint source', async () => {
    const feature = new MockStatefulFeature('isolation');
    feature.counter = 10;

    const features = makeFeatureMap(feature);
    const snapshots = captureFeatureSnapshots(features);

    // Restore
    await restoreFeatureSnapshots(snapshots, features);
    expect(feature.counter).toBe(10);

    // Mutate feature after restore
    feature.counter = 777;

    // The snapshot in the array should still be original
    const snap = snapshots[0].snapshot as StatefulFeatureData;
    expect(snap.counter).toBe(10);
  });
});
