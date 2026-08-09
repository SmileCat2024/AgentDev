/**
 * 反向钩子注册表
 *
 * 管理反向钩子的注册、发现和执行
 */

import type { AgentFeature } from './feature.js';
import { CoreLifecycle, Decision, type DecisionResult, normalizeDecision } from './lifecycle.js';
import { getDecoratorMetadata } from './hooks-decorator.js';
import type { DecisionContext, HookLifecycleSnapshot } from './types.js';
import { createLogger, runWithLogScope } from './logging.js';

const logger = createLogger('agent.reverse-hook');

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
  private hooks = new Map<CoreLifecycle, Array<{
    feature: AgentFeature;
    methodName: string;
    source?: { file?: string; line?: number; column?: number; display: string };
    enabled: boolean;
  }>>();

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
        const trimmed = methodName.trim();
        hookList.push({
          feature,
          methodName: trimmed,
          source: metadata.hookSources.get(`${lifecycle}:${trimmed}`),
          enabled: true,
        });
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
  get(lifecycle: CoreLifecycle): Array<{
    feature: AgentFeature;
    methodName: string;
    source?: { file?: string; line?: number; column?: number; display: string };
    enabled: boolean;
  }> {
    return this.hooks.get(lifecycle) || [];
  }

  /**
   * 禁用钩子（运行时跳过执行，不影响注册状态）
   *
   * @returns 是否成功（钩子存在且之前为启用状态）
   */
  disableHook(lifecycle: CoreLifecycle, featureName: string, methodName: string): boolean {
    const hooks = this.hooks.get(lifecycle);
    if (!hooks) return false;

    const entry = hooks.find(h => h.feature.name === featureName && h.methodName === methodName);
    if (!entry || !entry.enabled) return false;

    entry.enabled = false;
    return true;
  }

  /**
   * 启用钩子
   *
   * @returns 是否成功（钩子存在且之前为禁用状态）
   */
  enableHook(lifecycle: CoreLifecycle, featureName: string, methodName: string): boolean {
    const hooks = this.hooks.get(lifecycle);
    if (!hooks) return false;

    const entry = hooks.find(h => h.feature.name === featureName && h.methodName === methodName);
    if (!entry || entry.enabled) return false;

    entry.enabled = true;
    return true;
  }

  getSnapshot(): HookLifecycleSnapshot[] {
    return Object.values(CoreLifecycle).map((lifecycle) => {
      const entries = (this.hooks.get(lifecycle) || []).map((hook, index) => ({
        order: index + 1,
        featureName: hook.feature.name,
        methodName: hook.methodName,
        lifecycle,
        kind: lifecycle === CoreLifecycle.StepFinish || lifecycle === CoreLifecycle.ToolUse
          ? 'decision' as const
          : lifecycle === CoreLifecycle.ToolResultTransform
            ? 'transform' as const
            : 'notify' as const,
        source: hook.source,
        description: typeof (hook.feature as any).getHookDescription === 'function'
          ? (hook.feature as any).getHookDescription(lifecycle, hook.methodName)
          : undefined,
        enabled: hook.enabled,
      }));

      return {
        lifecycle,
        kind: lifecycle === CoreLifecycle.StepFinish || lifecycle === CoreLifecycle.ToolUse
          ? 'decision' as const
          : lifecycle === CoreLifecycle.ToolResultTransform
            ? 'transform' as const
            : 'notify' as const,
        entries,
      };
    });
  }

  /**
   * 执行指定生命周期的所有反向钩子
   *
   * @param lifecycle 生命周期类型
   * @param context 决策上下文
   * @returns 执行结果
   */
  async execute(lifecycle: CoreLifecycle, context: DecisionContext): Promise<HookExecutionResult> {
    const allHooks = this.hooks.get(lifecycle);

    if (!allHooks || allHooks.length === 0) {
      return { handled: false };
    }

    // 入口快照：冻结本次 dispatch 的有效钩子
    // mid-dispatch 的 enable/disable 不影响本次执行，从下一次生命周期触发生效
    const activeHooks = allHooks.filter(h => h.enabled);

    if (activeHooks.length === 0) {
      return { handled: false };
    }

    // 按顺序执行所有钩子
    for (const { feature, methodName, source } of activeHooks) {
      try {
        const method = (feature as any)[methodName];
        if (typeof method !== 'function') {
          console.warn(
            `[HooksRegistry] 钩子方法 ${methodName} 在 Feature ${feature.name} 中不存在`
          );
          continue;
        }

        const result = await runWithLogScope({
          feature: feature.name,
          lifecycle,
          hookMethod: methodName,
          hookKind: 'reverse',
          sourceFile: source?.file,
          sourceLine: source?.line,
          namespace: 'agent.reverse-hook',
          tags: [
            'reverse-hook',
            `feature:${feature.name}`,
            `hook:${lifecycle}`,
            `hook-method:${methodName}`,
          ],
        }, async () => await method.call(feature, context));

        // 处理返回值
        if (result !== undefined) {
          const decision = normalizeDecision(result);

          // 如果返回 Approve 或 Deny，立即停止并返回
          if (decision === Decision.Approve || decision === Decision.Deny) {
            logger.info('Reverse hook decided flow', {
              feature: feature.name,
              lifecycle,
              methodName,
              decision,
            });
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
        logger.error('Reverse hook execution failed', {
          feature: feature.name,
          lifecycle,
          methodName,
          message,
        });
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
   * 执行数据变换钩子（链式，返回变换后的数据）
   *
   * 每个钩子接收上下文（其中包含当前 result），返回新的 result 替换之。
   * 返回 undefined 表示不修改，继续传递当前值。
   * 某个钩子抛异常时跳过该钩子，继续传递当前值（不中断链）。
   *
   * @param lifecycle 生命周期类型（应为 ToolResultTransform）
   * @param initialResult 初始结果
   * @param buildContext 根据当前结果构建上下文的函数
   * @returns 变换后的结果
   */
  async executeTransform<T>(
    lifecycle: CoreLifecycle,
    initialResult: T,
    buildContext: (current: T) => DecisionContext,
  ): Promise<T> {
    const allHooks = this.hooks.get(lifecycle);

    if (!allHooks || allHooks.length === 0) {
      return initialResult;
    }

    // 入口快照：冻结本次 dispatch 的有效钩子
    const activeHooks = allHooks.filter(h => h.enabled);

    if (activeHooks.length === 0) {
      return initialResult;
    }

    let current = initialResult;

    for (const { feature, methodName, source } of activeHooks) {
      try {
        const method = (feature as any)[methodName];
        if (typeof method !== 'function') {
          console.warn(
            `[HooksRegistry] 变换钩子方法 ${methodName} 在 Feature ${feature.name} 中不存在`
          );
          continue;
        }

        const ctx = buildContext(current);
        const returned = await runWithLogScope({
          feature: feature.name,
          lifecycle,
          hookMethod: methodName,
          hookKind: 'transform',
          sourceFile: source?.file,
          sourceLine: source?.line,
          namespace: 'agent.reverse-hook',
          tags: [
            'transform-hook',
            `feature:${feature.name}`,
            `hook:${lifecycle}`,
            `hook-method:${methodName}`,
          ],
        }, async () => await method.call(feature, ctx));

        if (returned !== undefined) {
          current = returned as T;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Transform hook execution failed', {
          feature: feature.name,
          lifecycle,
          methodName,
          message,
        });
        console.error(
          `[HooksRegistry] 执行变换钩子 ${CoreLifecycle[lifecycle]}#${methodName} 时出错: ${message}`
        );
        // 继续传递当前值，不中断链
      }
    }

    return current;
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
