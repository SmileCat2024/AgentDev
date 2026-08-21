import { describe, it, expect } from 'vitest';
import { ExampleFeature } from '../index.js';

describe('Example Feature smoke', () => {
  it('should start with enabled=true and counter=0', () => {
    const feature = new ExampleFeature();
    const snapshot = feature.captureState() as { enabled: boolean; counter: number };

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.counter).toBe(0);
  });
});
