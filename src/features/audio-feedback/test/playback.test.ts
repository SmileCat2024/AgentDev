import { describe, it, expect } from 'vitest';
import { AudioFeedbackFeature } from '../index.js';
import { type FeatureInitContext } from '../../../core/feature.js';
import type { CallFinishContext } from '../../../core/lifecycle.js';

function createMockInitContext(): FeatureInitContext {
  return {
    agentId: 'test-agent',
    config: { llm: null as any },
    logger: {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => null as any,
    },
    featureConfig: undefined,
    getFeature: () => undefined,
    registerTool: () => {},
  };
}

function createMockCallFinishContext(): CallFinishContext {
  return {
    input: 'test input',
    context: { add: () => {}, getAll: () => [] } as any,
    response: 'test response',
    steps: 1,
    completed: true,
    finishReason: 'completed',
  };
}

describe('Audio Feedback Feature playback', () => {
  it('should initialize and destroy cleanly', async () => {
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });

    await feature.onInitiate(createMockInitContext());

    feature.setEnabled(false);
    const disabledCtx = createMockCallFinishContext();
    expect(disabledCtx).toBeDefined();

    feature.setEnabled(true);
    const playCountBefore = feature.getPlayCount();
    const playCountAfter = feature.getPlayCount();
    expect(playCountAfter).toBe(playCountBefore);

    await feature.onDestroy({ agentId: 'test-agent' } as any);

    const snapshot = feature.captureState() as { audioPath: string };
    expect(snapshot.audioPath.length).toBeGreaterThan(0);
    expect(snapshot.audioPath.endsWith('.mp3')).toBe(true);
  });
});
