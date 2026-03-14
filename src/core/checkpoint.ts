import type { Context, ContextSnapshot } from './context.js';
import type { AgentFeature, FeatureStateSnapshot } from './feature.js';

export interface FeatureCheckpoint {
  featureName: string;
  snapshot: FeatureStateSnapshot;
}

export interface StepCheckpoint {
  context: ContextSnapshot;
  features: FeatureCheckpoint[];
}

function cloneFeatureSnapshot(snapshot: FeatureStateSnapshot): FeatureStateSnapshot {
  if (typeof structuredClone === 'function') {
    return structuredClone(snapshot);
  }
  return JSON.parse(JSON.stringify(snapshot)) as FeatureStateSnapshot;
}

export function createStepCheckpoint(
  context: Context,
  features?: Map<string, AgentFeature>,
): StepCheckpoint {
  return {
    context: context.toJSON(),
    features: captureFeatureSnapshots(features),
  };
}

export async function rollbackToStepCheckpoint(
  checkpoint: StepCheckpoint,
  context: Context,
  features?: Map<string, AgentFeature>,
): Promise<void> {
  await restoreFeatureSnapshots(checkpoint.features, features, {
    beforeEach: async (feature, snapshot) => {
      await feature.beforeRollback?.(snapshot);
    },
    afterEach: async (feature, snapshot) => {
      await feature.afterRollback?.(snapshot);
    },
  });
  context.restore(checkpoint.context);
}

export async function restoreFeatureSnapshots(
  checkpoints: FeatureCheckpoint[],
  features?: Map<string, AgentFeature>,
  hooks?: {
    beforeEach?: (feature: AgentFeature, snapshot: FeatureStateSnapshot) => Promise<void>;
    afterEach?: (feature: AgentFeature, snapshot: FeatureStateSnapshot) => Promise<void>;
  },
): Promise<void> {
  const featureMap = features ?? new Map<string, AgentFeature>();

  for (const entry of checkpoints) {
    const feature = featureMap.get(entry.featureName);
    if (!feature || !feature.restoreState) continue;
    const snapshot = cloneFeatureSnapshot(entry.snapshot);
    await hooks?.beforeEach?.(feature, snapshot);
    await feature.restoreState(snapshot);
    await hooks?.afterEach?.(feature, snapshot);
  }
}

export function captureFeatureSnapshots(features?: Map<string, AgentFeature>): FeatureCheckpoint[] {
  if (!features) return [];

  const checkpoints: FeatureCheckpoint[] = [];
  for (const [featureName, feature] of features.entries()) {
    if (!feature.captureState || !feature.restoreState) {
      continue;
    }
    checkpoints.push({
      featureName,
      snapshot: cloneFeatureSnapshot(feature.captureState()),
    });
  }
  return checkpoints;
}
