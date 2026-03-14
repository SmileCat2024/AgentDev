/**
 * Audio Feedback Feature Smoke Test
 * 测试 Feature 的基本功能和 API
 */

import { AudioFeedbackFeature } from '../index.js';
import type { AudioFeedbackSnapshot } from '../types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  console.log('[START] Audio Feedback Feature smoke test\n');

  // 1. 测试 Feature 创建
  const feature = new AudioFeedbackFeature({
    enabled: true,
    volume: 0.5,
  });

  assert(feature.name === 'audio-feedback', 'feature name should be audio-feedback');
  assert(feature.description !== undefined, 'feature should have description');
  assert(feature.isEnabled() === true, 'feature should be enabled by default');
  console.log('[PASS] Feature creation and basic properties');

  // 2. 测试状态快照
  const snapshot = feature.captureState() as AudioFeedbackSnapshot;

  assert(snapshot.enabled === true, 'snapshot should show enabled');
  assert(snapshot.volume === 0.5, 'snapshot volume should be 0.5');
  assert(typeof snapshot.audioPath === 'string', 'snapshot should have audioPath');
  assert(snapshot.playCount === 0, 'playCount should start at 0');
  console.log('[PASS] State snapshot');

  // 3. 测试 API 方法
  feature.setEnabled(false);
  assert(feature.isEnabled() === false, 'feature should be disabled');
  console.log('[PASS] setEnabled(false)');

  feature.setEnabled(true);
  assert(feature.isEnabled() === true, 'feature should be enabled');
  console.log('[PASS] setEnabled(true)');

  feature.setVolume(0.8);
  const newSnapshot = feature.captureState() as AudioFeedbackSnapshot;
  assert(newSnapshot.volume === 0.8, 'volume should be updated to 0.8');
  console.log('[PASS] setVolume(0.8)');

  // 4. 测试音量边界
  feature.setVolume(1.5); // 超过 1 应被限制
  const clampedSnapshot = feature.captureState() as AudioFeedbackSnapshot;
  assert(clampedSnapshot.volume === 1, 'volume should be clamped to 1');
  console.log('[PASS] Volume clamping (max 1)');

  feature.setVolume(-0.5); // 低于 0 应被限制
  const minSnapshot = feature.captureState() as AudioFeedbackSnapshot;
  assert(minSnapshot.volume === 0, 'volume should be clamped to 0');
  console.log('[PASS] Volume clamping (min 0)');

  // 5. 测试播放计数
  assert(feature.getPlayCount() === 0, 'playCount should start at 0');
  console.log('[PASS] getPlayCount()');

  // 6. 测试状态恢复
  const testSnapshot: AudioFeedbackSnapshot = {
    enabled: false,
    volume: 0.3,
    audioPath: '/test/path.mp3',
    playCount: 42,
  };

  feature.restoreState(testSnapshot);
  const restoredSnapshot = feature.captureState() as AudioFeedbackSnapshot;

  assert(restoredSnapshot.enabled === false, 'should restore enabled state');
  assert(restoredSnapshot.volume === 0.3, 'should restore volume');
  assert(restoredSnapshot.playCount === 42, 'should restore playCount');
  console.log('[PASS] State restoration');

  console.log('\n[DONE] Audio Feedback Feature smoke test passed');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
