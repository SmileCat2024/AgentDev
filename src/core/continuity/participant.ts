/**
 * Continuity Participant（中性化协议层，ticket 006 从 Claw 下沉）。
 *
 * 让一个 Feature 类获得 AgentDev continuity 协议的自声明能力。
 *
 * 设计理念：
 * - 框架自带的 Feature 不需要知道 continuity 的具体协议，本模块以「包装类继承
 *   原 feature」模式为它们附加协议字段，与「extends 原 feature 添加能力」是
 *   同一种模式。
 * - 包装类负责三件事：
 *     1. 提供 getContinuityDescriptor()，让 import 端可从 agent 实例查询声明
 *     2. override captureState()，把 descriptor 注入 snapshot（让无 agent 的
 *        export 端也能读到）
 *     3. override restoreState()，把 descriptor 字段剥离后再交给原 feature 处理
 * - 第三方 feature 想参与 continuity 时，自己 declareContinuity 包装一下即可，
 *   无需回框架中心登记。
 */

import type { AgentFeature, FeatureStateSnapshot } from '../feature.js';

/**
 * 快照中携带 continuity descriptor 的保留字段名。
 * 加 __ 前缀降低与业务字段碰撞的概率。
 *
 * （ticket 006 中性化：原 Claw 字段 `__claw_continuity__` → `__agentdev_continuity__`）
 */
export const CONTINUITY_FIELD_KEY = '__agentdev_continuity__';

/**
 * 通用 continuity 协议：无 schema 适配，state 原样进出。
 *
 * 大多数 feature 用这个协议就够了——只要它的 captureState 返回值是
 * 可序列化的纯数据，无需特化清理。
 */
export const GENERIC_CONTINUITY_PROTOCOL = 'agentdev.feature-continuity.v1';

/**
 * OpencodeBasic 的专用 continuity 协议。
 *
 * 接续时保留「先读后写」校验需要的 readFiles，
 * 但不继承依赖旧上下文内容的 readDedupState。
 */
export const OPENCODE_BASIC_CONTINUITY_PROTOCOL = 'agentdev.opencode-basic-continuity.v1';

/**
 * AgentDev continuity descriptor：feature 自声明参与 continuity 的合约。
 *
 * protocol    —— 协议标识符。协议层维护一张 protocol → adapter 的开放命名空间，
 *                未登记的 protocol 走透传（无 adapter）。只有需要特化清理
 *                （如 schema 规范化）的协议才在协议层登记 adapter。
 * importMode  —— 导入时的合并语义。当前仅 'replace'（直接覆盖 feature 内存状态）。
 */
export interface AgentdevContinuityDescriptor {
  protocol: string;
  importMode?: 'replace' | 'merge';
}

/** 从 snapshot 读取 continuity descriptor。无声明返回 null。 */
export function readContinuityDescriptor(snapshot: unknown): AgentdevContinuityDescriptor | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const descriptor = (snapshot as Record<string, unknown>)[CONTINUITY_FIELD_KEY];
  if (!descriptor || typeof descriptor !== 'object') return null;
  const protocol = (descriptor as { protocol?: unknown }).protocol;
  if (typeof protocol !== 'string' || !protocol.trim()) return null;
  return descriptor as AgentdevContinuityDescriptor;
}

/** 从 snapshot 剥离 continuity 字段，返回纯 state。 */
export function stripContinuityField(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const record = snapshot as Record<string, unknown>;
  if (!(CONTINUITY_FIELD_KEY in record)) return snapshot;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== CONTINUITY_FIELD_KEY) {
      rest[key] = record[key];
    }
  }
  return rest;
}

type AnyFeatureConstructor = new (...args: any[]) => AgentFeature;

/**
 * 高阶函数：让一个 Feature 类获得 continuity 自声明能力。
 *
 * @example
 * ```ts
 * import { OpencodeBasicFeature } from 'agentdev';
 * import { declareContinuity, GENERIC_CONTINUITY_PROTOCOL } from 'agentdev';
 *
 * export const ContinuityAwareOpencodeBasic = declareContinuity(OpencodeBasicFeature, {
 *   protocol: GENERIC_CONTINUITY_PROTOCOL,
 *   importMode: 'replace',
 * });
 * ```
 *
 * 包装后的类：
 * - 继承原 feature 的所有行为（工具、hooks、原 captureState/restoreState 语义）
 * - 多出 getContinuityDescriptor() 方法
 * - captureState 在原返回值上叠加 [CONTINUITY_FIELD_KEY] 字段
 * - restoreState 先剥离该字段再调用原 restoreState
 */
export function declareContinuity<T extends AnyFeatureConstructor>(
  Base: T,
  descriptor: AgentdevContinuityDescriptor,
): T {
  const normalizedDescriptor: AgentdevContinuityDescriptor = {
    protocol: descriptor.protocol,
    importMode: descriptor.importMode === 'merge' ? 'merge' : 'replace',
  };

  return class ContinuityAware extends Base {
    /**
     * 标志位：restoreState 是否被调用过。
     * - restored resume / session load 场景：restoreState 被调用 → true
     * - 全新 session 首次启动：restoreState 未被调用 → false
     * onInitiate 根据此标志决定是否保护已恢复的状态。
     */
    private _continuityStateRestored = false;

    getContinuityDescriptor(): AgentdevContinuityDescriptor {
      return { ...normalizedDescriptor };
    }

    /**
     * Override onInitiate：防止基类的初始化逻辑清空 continuity/session 已恢复的状态。
     *
     * 策略：仅当 restoreState 被调用过（_continuityStateRestored=true）时，才在基类
     * onInitiate 执行后用 buffer 恢复状态。全新 session 首次启动时不干预，保留基类
     * onInitiate 的默认初始化行为。
     */
    async onInitiate(ctx: any): Promise<void> {
      const wasRestored = this._continuityStateRestored;
      const beforeBuffer = wasRestored ? stripContinuityField(super.captureState!()) : null;

      if (typeof super.onInitiate === 'function') {
        await super.onInitiate(ctx);
      }

      if (wasRestored && beforeBuffer && typeof beforeBuffer === 'object') {
        await super.restoreState!(beforeBuffer as FeatureStateSnapshot);
      }
    }

    captureState(): FeatureStateSnapshot {
      const base = super.captureState!();
      if (base && typeof base === 'object') {
        return { ...(base as Record<string, unknown>), [CONTINUITY_FIELD_KEY]: normalizedDescriptor };
      }
      return { [CONTINUITY_FIELD_KEY]: normalizedDescriptor } as FeatureStateSnapshot;
    }

    async restoreState(snapshot: FeatureStateSnapshot): Promise<void> {
      this._continuityStateRestored = true;
      if (snapshot && typeof snapshot === 'object' && CONTINUITY_FIELD_KEY in (snapshot as Record<string, unknown>)) {
        const stripped = stripContinuityField(snapshot);
        await super.restoreState!(stripped as FeatureStateSnapshot);
        return;
      }
      await super.restoreState!(snapshot);
    }
  };
}
