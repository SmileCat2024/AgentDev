/**
 * 反向钩子注册表
 *
 * 管理反向钩子的注册、发现和执行
 */

import type { AgentFeature } from './feature.js';
import { CoreLifecycle, Decision, DecisionResult, normalizeDecision } from './lifecycle.js';
import { getDecoratorMetadata } from './hooks-decorator.js';
import type { DecisionContext } from './types.js';

/**
 * 钩子执行结果
 */
export interface HookExecutionResult {
  /** 是否有钩子被处理 */
  handled: boolean;
  /** 决策结果（仅当有流程控制能力时） */
  decision?: Decision;
  /** 拒绝原因（如果被拒绝） */
  reason?: string;
  /** 附加元数据 */
  metadata?: Record<string, any>;
}

/**
 * 钩子注册表
 *
 * 管理所有 Feature 的反向钩子
 */
export class HooksRegistry {
  /** 生命周期 → Feature 映射 → 方法名 */
  private hooks = new Map<CoreLifecycle, Array<{ feature: AgentFeature; methodName: string }>>();

  /**
   * 从 Feature 收集反向钩子
   *
   * @param feature Feature 实例
   */
  collectFromFeature(feature: AgentFeature): void {
    const metadata = getDecoratorMetadata(feature);

    for (const [lifecycle, methodNameOrList] of metadata.hookDecisions.entries()) {
      if (!this.hooks.has(lifecycle)) {
        this.hooks.set(lifecycle, []);
      }
      const hookList = this.hooks.get(lifecycle)!;

      // 支持多个方法（用逗号分隔）
      const methodNames = methodNameOrList.split(',');
      for (const methodName of methodNames) {
        hookList.push({ feature, methodName: methodName.trim() });
      }
    }
  }

  /**
   * 移除 Feature 的所有钩子
   *
   * @param feature Feature 实例
   */
  removeFromFeature(feature: AgentFeature): void {
    for (const hooks of this.hooks.values()) {
      // 过滤掉属于该 Feature 的所有钩子
      const filtered = hooks.filter(h => h.feature !== feature);
      hooks.length = 0;
      hooks.push(...filtered);
    }
  }

  /**
   * 检查是否有指定的钩子
   *
   * @param lifecycle 生命周期类型
   * @returns 是否存在钩子
   */
  has(lifecycle: CoreLifecycle): boolean {
    const hooks = this.hooks.get(lifecycle);
    return hooks !== undefined && hooks.length > 0;
  }

  /**
   * 获取指定生命周期的所有钩子
   *
   * @param lifecycle 生命周期类型
   * @returns 钩子列表
   */
  get(lifecycle: CoreLifecycle): Array<{ feature: AgentFeature; methodName: string }> {
    return this.hooks.get(lifecycle) || [];
  }

  /**
   * 执行指定生命周期的所有反向钩子
   *
   * @param lifecycle 生命周期类型
   * @param context 决策上下文
   * @returns 执行结果
   */
  async execute(lifecycle: CoreLifecycle, context: DecisionContext): Promise<HookExecutionResult> {
    const hooks = this.hooks.get(lifecycle);

    if (!hooks || hooks.length === 0) {
      return { handled: false };
    }

    // 按顺序执行所有钩子
    for (const { feature, methodName } of hooks) {
      try {
        const method = (feature as any)[methodName];
        if (typeof method !== 'function') {
          console.warn(
            `[HooksRegistry] 钩子方法 ${methodName} 在 Feature ${feature.name} 中不存在`
          );
          continue;
        }

        const result = await method.call(feature, context);

        // 处理返回值
        if (result !== undefined) {
          const decision = normalizeDecision(result);

          // 如果返回 Approve 或 Deny，立即停止并返回
          if (decision === Decision.Approve || decision === Decision.Deny) {
            return {
              handled: true,
              decision,
              reason: typeof result === 'object' && result.reason ? result.reason : undefined,
              metadata: typeof result === 'object' && result.metadata ? result.metadata : undefined,
            };
          }

          // Continue 继续下一个钩子
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[HooksRegistry] 执行钩子 ${CoreLifecycle[lifecycle]}#${methodName} 时出错: ${message}`
        );
        // 继续执行下一个钩子
      }
    }

    // 所有钩子都返回 Continue 或没有明确返回值
    return { handled: true, decision: Decision.Continue };
  }

  /**
   * 执行有流程控制能力的钩子（返回 DecisionResult）
   *
   * @param lifecycle 生命周期类型
   * @param context 决策上下文
   * @returns 决策结果
   */
  async executeDecision(
    lifecycle: CoreLifecycle,
    context: DecisionContext
  ): Promise<DecisionResult> {
    const result = await this.execute(lifecycle, context);

    if (!result.handled) {
      return Decision.Continue;
    }

    if (result.decision === Decision.Approve) {
      return { action: Decision.Approve, reason: result.reason, metadata: result.metadata };
    }

    if (result.decision === Decision.Deny) {
      return { action: Decision.Deny, reason: result.reason, metadata: result.metadata };
    }

    return Decision.Continue;
  }

  /**
   * 执行无流程控制能力的钩子（返回 void）
   *
   * @param lifecycle 生命周期类型
   * @param context 决策上下文
   */
  async executeVoid(lifecycle: CoreLifecycle, context: DecisionContext): Promise<void> {
    await this.execute(lifecycle, context);
  }

  /**
   * 清空所有钩子
   */
  clear(): void {
    this.hooks.clear();
  }
}

// ========== 工具函数 ==========

/**
 * 创建全局钩子注册表
 */
export function createHooksRegistry(): HooksRegistry {
  return new HooksRegistry();
}
