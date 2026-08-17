import type { AgentFeature } from '../../core/feature.js';

/**
 * Feature 状态契约探测结果。
 *
 * - 'roundtrip'    captureState + restoreState 齐备，可参与状态往返
 * - 'no-state'     两者都未实现：热载/回滚时内存状态丢失（需显式登记）
 * - 'capture-only' 只实现 captureState：框架消费路径会跳过（等同丢状态）
 * - 'restore-only' 只实现 restoreState：异常实现（capture 都没有，无源可恢复）
 */
export type StateRoundtripStatus =
  | 'roundtrip'
  | 'no-state'
  | 'capture-only'
  | 'restore-only';

export interface StateRoundtripProbe {
  featureName: string;
  status: StateRoundtripStatus;
  /**
   * status === 'roundtrip' 时：
   * capture → 序列化 → restore 到新实例 → 二次 capture 的全等结果。
   * false 表示快照不可完整还原（如 restore 为惰性 no-op）。
   */
  roundtripEqual?: boolean;
  /** captureState 顶层字段名（字段名契约） */
  capturedFields?: string[];
}

/**
 * 判定 feature 的状态契约形态。
 */
export function probeCaptureRestoreStatus(feature: AgentFeature): StateRoundtripStatus {
  const hasCapture = typeof feature.captureState === 'function';
  const hasRestore = typeof feature.restoreState === 'function';
  if (hasCapture && hasRestore) return 'roundtrip';
  if (hasCapture) return 'capture-only';
  if (hasRestore) return 'restore-only';
  return 'no-state';
}

/**
 * 序列化克隆 — 镜像 src/core/checkpoint.ts 的 cloneFeatureSnapshot。
 *
 * 往返测试必须走与生产相同的克隆路径（structuredClone 优先，
 * 回退 JSON），否则测不到不可序列化状态（Set/Map/循环引用等）。
 */
export function cloneSnapshotLikeFramework(snapshot: unknown): unknown {
  if (typeof structuredClone === 'function') {
    return structuredClone(snapshot);
  }
  return JSON.parse(JSON.stringify(snapshot));
}

/**
 * 状态往返探测：镜像框架真实路径
 * （checkpoint.ts 的 captureFeatureSnapshots / restoreFeatureSnapshots）。
 *
 * 流程：
 * 1. factory() 创建实例 A，mutate 将状态置为非默认值
 * 2. A.captureState() → 框架克隆 → 恢复到新实例 B（同 factory 构造）
 * 3. B.captureState() 与 A 的快照深比对
 *
 * 全等 = 回滚/热载后状态可完整还原。
 * 不全等 = 快照存在但 restore 不完整（如惰性恢复），热载丢部分状态。
 */
export async function probeStateRoundtrip(
  factory: () => AgentFeature,
  mutate?: (feature: AgentFeature) => void | Promise<void>,
): Promise<StateRoundtripProbe> {
  const source = factory();
  const status = probeCaptureRestoreStatus(source);

  if (status !== 'roundtrip') {
    return { featureName: source.name, status };
  }

  await mutate?.(source);

  const snapshot = source.captureState!();
  const capturedFields = Object.keys(snapshot as Record<string, unknown>).sort();

  const target = factory();
  await target.restoreState!(cloneSnapshotLikeFramework(snapshot));

  const recaptured = target.captureState!();
  const roundtripEqual = deepEqual(
    cloneSnapshotLikeFramework(recaptured),
    cloneSnapshotLikeFramework(snapshot),
  );

  return { featureName: source.name, status, roundtripEqual, capturedFields };
}

/**
 * 结构化深比对（值语义：数组逐元素、对象逐键、原始值严格相等）。
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(key =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}
