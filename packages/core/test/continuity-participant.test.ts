/**
 * Continuity Participant 中性化协议层测试。
 *
 * 自 Claw `local-features/continuity-participant/test/oninitiate-protection.test.ts`
 * 移植，断言与 Claw 一致，字段/协议名采用中性化命名
 * （__agentdev_continuity__ / agentdev.feature-continuity.v1）。
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  declareContinuity,
  GENERIC_CONTINUITY_PROTOCOL,
  CONTINUITY_FIELD_KEY,
} from '../src/core/continuity/participant.js';

/**
 * 模拟框架自带 Feature（类似 OpencodeBasicFeature）：
 * - onInitiate 会清空内部状态（模拟 readFiles.clear()）
 * - captureState/restoreState 正常存取
 */
function createFeatureWithClearingOnInitiate(featureName: string): any {
  return class MockFeature {
    readonly name = featureName;
    private _state: Record<string, unknown> = {};
    private _initCallCount = 0;

    async onInitiate(): Promise<void> {
      this._initCallCount += 1;
      this._state = {};
    }

    captureState() {
      return { ...this._state };
    }

    restoreState(snapshot: any) {
      this._state = { ...(snapshot || {}) };
    }
  };
}

describe('declareContinuity onInitiate protection', () => {
  it('preserves restored state across onInitiate when restoreState was called', async () => {
    const Wrapped: any = declareContinuity(
      createFeatureWithClearingOnInitiate('mock-feature'),
      { protocol: GENERIC_CONTINUITY_PROTOCOL, importMode: 'replace' },
    );

    const feature: any = new Wrapped();

    feature.restoreState({ readFiles: ['/repo/a.ts', '/repo/b.ts'] });

    assert.deepEqual(feature.captureState().readFiles, ['/repo/a.ts', '/repo/b.ts']);

    await feature.onInitiate({});

    assert.deepEqual(
      feature.captureState().readFiles,
      ['/repo/a.ts', '/repo/b.ts'],
      'readFiles should survive onInitiate when previously restored',
    );
    assert.equal(
      feature.captureState()[CONTINUITY_FIELD_KEY].protocol,
      GENERIC_CONTINUITY_PROTOCOL,
    );
  });

  it('does not interfere with onInitiate default behavior on fresh session', async () => {
    const Wrapped: any = declareContinuity(
      createFeatureWithClearingOnInitiate('mock-feature'),
      { protocol: GENERIC_CONTINUITY_PROTOCOL, importMode: 'replace' },
    );

    const feature: any = new Wrapped();

    await feature.onInitiate({});

    const state = feature.captureState();
    assert.equal(state[CONTINUITY_FIELD_KEY].protocol, GENERIC_CONTINUITY_PROTOCOL);
    assert.deepEqual(state.readFiles, undefined);
  });

  it('restores state correctly when snapshot carries the continuity field', async () => {
    const Wrapped: any = declareContinuity(
      createFeatureWithClearingOnInitiate('mock-feature'),
      { protocol: GENERIC_CONTINUITY_PROTOCOL, importMode: 'replace' },
    );

    const source: any = new Wrapped();
    source.restoreState({ readFiles: ['/x.ts'] });
    const snapshot = source.captureState();
    assert.ok(CONTINUITY_FIELD_KEY in snapshot);

    const target: any = new Wrapped();
    target.restoreState(snapshot);
    assert.deepEqual(target.captureState().readFiles, ['/x.ts']);

    await target.onInitiate({});
    assert.deepEqual(target.captureState().readFiles, ['/x.ts']);
  });
});
