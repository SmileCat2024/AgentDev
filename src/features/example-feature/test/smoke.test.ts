import { ExampleFeature } from '../index.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const feature = new ExampleFeature();
const snapshot = feature.captureState() as { enabled: boolean; counter: number };

assert(snapshot.enabled === true, 'example feature should enable by default');
assert(snapshot.counter === 0, 'example feature counter should start at zero');

console.log('Example feature smoke test passed');
