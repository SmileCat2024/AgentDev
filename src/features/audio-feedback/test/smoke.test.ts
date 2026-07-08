import { describe, it, expect } from 'vitest';
import { AudioFeedbackFeature } from '../index.js';
import type { AudioFeedbackSnapshot } from '../types.js';

describe('Audio Feedback Feature smoke', () => {
  it('should create with correct basic properties', () => {
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });

    expect(feature.name).toBe('audio-feedback');
    expect(feature.description).toBeDefined();
    expect(feature.isEnabled()).toBe(true);
  });

  it('should capture correct state snapshot', () => {
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });
    const snapshot = feature.captureState() as AudioFeedbackSnapshot;

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.volume).toBe(0.5);
    expect(typeof snapshot.audioPath).toBe('string');
    expect(snapshot.playCount).toBe(0);
    expect(snapshot.activeMode).toBeNull();
  });

  it('should expose two flow modes', () => {
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });
    const flowModes = feature.getFlowModes?.() || [];

    expect(flowModes).toHaveLength(2);
    expect(flowModes.some(mode => mode.id === 'play-feedback')).toBe(true);
    expect(flowModes.some(mode => mode.id === 'mute-feedback')).toBe(true);
  });

  it('should toggle enabled state and flow modes', () => {
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });

    feature.setEnabled(false);
    expect(feature.isEnabled()).toBe(false);

    feature.setEnabled(true);
    expect(feature.isEnabled()).toBe(true);

    feature.applyFlowMode?.('mute-feedback');
    expect(feature.isEnabled()).toBe(false);

    feature.applyFlowMode?.('play-feedback');
    expect(feature.isEnabled()).toBe(true);

    feature.resetFlowModes?.();
    expect(feature.isEnabled()).toBe(true);
  });

  it('should clamp volume to valid range', () => {
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });

    feature.setVolume(0.8);
    expect((feature.captureState() as AudioFeedbackSnapshot).volume).toBe(0.8);

    feature.setVolume(1.5);
    expect((feature.captureState() as AudioFeedbackSnapshot).volume).toBe(1);

    feature.setVolume(-0.5);
    expect((feature.captureState() as AudioFeedbackSnapshot).volume).toBe(0);
  });

  it('should restore state from snapshot', () => {
    const feature = new AudioFeedbackFeature({ enabled: true, volume: 0.5 });

    const testSnapshot: AudioFeedbackSnapshot = {
      enabled: false,
      volume: 0.3,
      audioPath: '/test/path.mp3',
      playCount: 42,
      activeMode: 'mute-feedback',
    };

    feature.restoreState(testSnapshot);
    const restored = feature.captureState() as AudioFeedbackSnapshot;

    expect(restored.enabled).toBe(false);
    expect(restored.volume).toBe(0.3);
    expect(restored.playCount).toBe(42);
    expect(restored.activeMode).toBe('mute-feedback');
  });
});
