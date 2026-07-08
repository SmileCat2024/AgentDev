import { describe, it, expect } from 'vitest';

describe('TTSFeature', () => {
  it('should import and instantiate without errors', async () => {
    const { TTSFeature } = await import('../index.js');
    const feature = new TTSFeature();

    expect(feature.name).toBe('tts');
    expect(feature.dependencies).toHaveLength(0);
    expect(feature.description).toBeTruthy();
  });

  it('should respect configuration', async () => {
    const { TTSFeature } = await import('../index.js');

    const feature = new TTSFeature({
      model: { voice: 'zf_xiaoxiao', speed: 1.2 },
      triggers: { minLength: 20, maxLength: 500 },
    });

    const state = feature['state'];
    expect(state).toBeDefined();
  });

  it('should capture and restore state', async () => {
    const { TTSFeature } = await import('../index.js');
    const feature = new TTSFeature();

    const snapshot1 = feature.captureState();
    expect(snapshot1).toBeDefined();

    feature['state'].enabled = false;
    feature['state'].totalUtterances = 5;

    const snapshot2 = feature.captureState();
    expect((snapshot2 as any).enabled).toBe(false);
    expect((snapshot2 as any).totalUtterances).toBe(5);

    feature.restoreState(snapshot1);
    expect(feature['state'].enabled).toBe(true);
    expect(feature['state'].totalUtterances).toBe(0);
  });

  it('should provide hook descriptions', async () => {
    const { TTSFeature } = await import('../index.js');
    const feature = new TTSFeature();

    const desc = feature.getHookDescription('StepFinish', 'speakOnStepFinish');
    expect(desc).toBeTruthy();
    expect(desc).toContain('朗读');
  });
});
