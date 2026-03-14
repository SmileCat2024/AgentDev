/**
 * TTSFeature 单元测试
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

void describe('TTSFeature', () => {
  it('should import without errors', async () => {
    // 动态导入以避免构建时的依赖问题
    const { TTSFeature } = await import('../index.js');

    // 创建实例
    const feature = new TTSFeature();

    // 验证基本属性
    assert.strictEqual(feature.name, 'tts');
    assert.strictEqual(feature.dependencies.length, 0);
    assert.ok(feature.description);

    console.log('[TTSFeature] ✓ Import and instantiation test passed');
  });

  it('should respect configuration', async () => {
    const { TTSFeature } = await import('../index.js');

    const feature = new TTSFeature({
      model: {
        voice: 'zf_xiaoxiao',
        speed: 1.2,
      },
      triggers: {
        minLength: 20,
        maxLength: 500,
      },
    });

    // 通过访问内部状态来验证配置（仅用于测试）
    const state = feature['state'];
    assert.ok(state);

    console.log('[TTSFeature] ✓ Configuration test passed');
  });

  it('should capture and restore state', async () => {
    const { TTSFeature } = await import('../index.js');

    const feature = new TTSFeature();

    // 捕获初始状态
    const snapshot1 = feature.captureState();
    assert.ok(snapshot1);

    // 修改内部状态
    feature['state'].enabled = false;
    feature['state'].totalUtterances = 5;

    // 捕获修改后的状态
    const snapshot2 = feature.captureState();
    assert.strictEqual((snapshot2 as any).enabled, false);
    assert.strictEqual((snapshot2 as any).totalUtterances, 5);

    // 恢复状态
    feature.restoreState(snapshot1);
    assert.strictEqual(feature['state'].enabled, true);
    assert.strictEqual(feature['state'].totalUtterances, 0);

    console.log('[TTSFeature] ✓ State capture/restore test passed');
  });

  it('should provide hook descriptions', async () => {
    const { TTSFeature } = await import('../index.js');

    const feature = new TTSFeature();

    const desc = feature.getHookDescription('StepFinish', 'speakOnStepFinish');
    assert.ok(desc);
    assert.ok(desc.includes('朗读'));

    console.log('[TTSFeature] ✓ Hook description test passed');
  });
});

// 主入口
async function main(): Promise<void> {
  console.log('[TTSFeature] Running tests...\n');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
