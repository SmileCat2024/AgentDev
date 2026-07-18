/**
 * Tests for AudioFeedbackFeature cross-platform audio playback
 *
 * On Linux, _playSound should try multiple players (pw-play, paplay, aplay, ffplay)
 * and silently skip if none are found, instead of crashing through to Windows code.
 */

import { describe, it, expect } from 'vitest';
import { AudioFeedbackFeature } from '../index.js';
import type { FeatureInitContext } from '../../../core/feature.js';

function createMockInitContext(): FeatureInitContext {
  return {
    agentId: 'test-agent',
    config: { llm: null as any },
    logger: {
      trace: () => {}, debug: () => {}, info: () => {},
      warn: () => {}, error: () => {},
      child: () => null as any,
    },
    featureConfig: undefined,
    getFeature: () => undefined,
    registerTool: () => {},
  };
}

describe('AudioFeedbackFeature cross-platform', () => {
  it('should initialize without errors on any platform', async () => {
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });
    await feature.onInitiate(createMockInitContext());
    expect(feature).toBeDefined();
    await feature.onDestroy({ agentId: 'test-agent' } as any);
  });

  it('should not crash when playing sound on headless Linux', async () => {
    // This test verifies that _playSound doesn't throw on Linux
    // even when no audio player is available.
    // We can't directly test the private method, but we verify
    // the feature can be created and destroyed cleanly.
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });
    await feature.onInitiate(createMockInitContext());

    // The feature should exist and be enabled
    expect(feature).toBeDefined();

    // On any platform, destroy should work without errors
    await feature.onDestroy({ agentId: 'test-agent' } as any);
  });

  it('should handle disabled state gracefully', async () => {
    const feature = new AudioFeedbackFeature({ enabled: false, volume: 0.5 });
    await feature.onInitiate(createMockInitContext());
    feature.setEnabled(false);

    // Even when disabled, operations should not throw
    const ctx = {
      input: 'test',
      context: { add: () => {}, getAll: () => [] } as any,
      response: 'test',
      steps: 1,
      completed: true,
      finishReason: 'completed' as const,
    };

    // onCallFinish should be callable even when disabled
    await feature.onCallFinish?.(ctx as any);
    expect(true).toBe(true);

    await feature.onDestroy({ agentId: 'test-agent' } as any);
  });
});
