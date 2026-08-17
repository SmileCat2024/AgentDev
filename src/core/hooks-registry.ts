/**
 * 反向钩子注册表
 *
 * 管理反向钩子的注册、发现和执行
 */

import type { AgentFeature } from './feature.js';
import { CoreLifecycle, Decision, type DecisionResult, normalizeDecision } from './lifecycle.js';
import {
  readHookDeclarations,
  validateHookDeclarations,
  issuesToError,
  type HookKind,
  type GuardRole,
} from './hook-declarations.js';
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

export interface RegisteredHook {
  feature: AgentFeature;
  methodName: string;
  source?: { file?: string; line?: number; column?: number; display: string };
  enabled: boolean;
  /** 三原语：来自静态声明（static hooks） */
  kind: HookKind;
  /** guard 角色（policy 先于 advisor）。仅 kind='guard' 条目存在。 */
  role?: GuardRole;
}

/**
 * 钩子注册表
 *
 * 管理所有 Feature 的反向钩子
 */
export class HooksRegistry {
  /** 生命周期 → Feature 映射 → 方法名 */
  private hooks = new Map<CoreLifecycle, Array<RegisteredHook>>();

  /**
   * 从 Feature 收集反向钩子
   *
   * 唯一入口：静态声明（static hooks）。
   * 没有声明 = 没有反向钩子，不存在第二条注册路径。
   * 声明校验失败直接抛错——装配错误不许运行时碰运气。
   *
   * @param feature Feature 实例
   */
  collectFromFeature(feature: AgentFeature): void {
    const declarations = readHookDeclarations(feature);

    if (Object.keys(declarations).length === 0) {
      return;
    }

    const issues = validateHookDeclarations(feature);
    if (issues.length > 0) {
      throw issuesToError(issues);
    }

    // policy 唯一性防守（覆盖 mountFeature 动态挂载场景；
    // 全量装配路径由 validatePolicyUniqueness 在 ensureFeatureTools 前置校验）
    for (const [method, decl] of Object.entries(declarations)) {
      if (decl.kind !== 'guard' || decl.role !== 'policy') continue;
      const existing = (this.hooks.get(decl.lifecycle) || [])
        .find(h => h.kind === 'guard' && h.role === 'policy' && h.feature !== feature);
      if (existing) {
        throw issuesToError([{
          feature: feature.name,
          method,
          code: 'duplicate_policy',
          message: `lifecycle '${decl.lifecycle}' 已有 '${existing.feature.name}#${existing.methodName}' 注册为 policy guard，'${feature.name}#${method}' 不能再次注册。修复：保留一个 policy，其余改为 role: 'advisor'。`,
        }]);
      }
    }

    for (const [method, decl] of Object.entries(declarations)) {
      if (!this.hooks.has(decl.lifecycle)) {
        this.hooks.set(decl.lifecycle, []);
      }
      this.hooks.get(decl.lifecycle)!.push({
        feature,
        methodName: method,
        source: undefined,
        enabled: true,
        kind: decl.kind,
        role: decl.role,
      });
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
  get(lifecycle: CoreLifecycle): Array<RegisteredHook> {
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
      const registered = this.hooks.get(lifecycle) || [];
      const entries = registered.map((hook, index) => ({
        order: index + 1,
        featureName: hook.feature.name,
        methodName: hook.methodName,
        lifecycle,
        kind: hook.kind,
        role: hook.role,
        source: hook.source,
        description: typeof (hook.feature as any).getHookDescription === 'function'
          ? (hook.feature as any).getHookDescription(lifecycle, hook.methodName)
          : undefined,
        enabled: hook.enabled,
      }));

      return {
        lifecycle,
        // 生命周期级三原语汇总（桶内有 guard → guard，有 transform → transform，否则 observe）
        kind: summarizeLifecycleKind(registered.map(h => h.kind)),
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

    // 三原语顺序法则（工作项 A1）：
    // - guard：policy 先于 advisor（组内保持注册序）
    // - observe：无序（框架按注册序执行仅为日志可复现）
    const orderedHooks = orderHooks(activeHooks);

    // 按顺序执行所有钩子
    for (const { feature, methodName, source, kind } of orderedHooks) {
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
          hookKind: kind,
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

        // observe / transform 条目：返回值由框架直接丢弃。
        // 消灭已知坑：void 钩子意外返回 'approve' 字符串静默短路同批观察者。
        // （transform 的正确调度是 executeTransform 链式执行）
        if (kind !== 'guard') {
          continue;
        }

        // guard：处理返回值
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
 * guard 顺序法则：policy 先于 advisor，组内保持注册序（稳定分区）。
 *
 * observe/transform 条目不参与裁决，排在 guard 之后保持注册序
 * （observe 无序；transform 不应出现在 execute() 调度中）。
 */
export function orderHooks(hooks: Array<RegisteredHook>): Array<RegisteredHook> {
  const policies: Array<RegisteredHook> = [];
  const advisors: Array<RegisteredHook> = [];
  const rest: Array<RegisteredHook> = [];

  for (const hook of hooks) {
    if (hook.kind === 'guard' && hook.role === 'policy') {
      policies.push(hook);
    } else if (hook.kind === 'guard') {
      advisors.push(hook);
    } else {
      rest.push(hook);
    }
  }

  return [...policies, ...advisors, ...rest];
}

/** 生命周期级三原语汇总：桶内有 guard → guard，有 transform → transform，否则 observe */
function summarizeLifecycleKind(kinds: Array<RegisteredHook['kind']>): HookKind {
  if (kinds.some(k => k === 'guard')) return 'guard';
  if (kinds.some(k => k === 'transform')) return 'transform';
  return 'observe';
}

/**
 * 创建全局钩子注册表
 */
export function createHooksRegistry(): HooksRegistry {
  return new HooksRegistry();
}
