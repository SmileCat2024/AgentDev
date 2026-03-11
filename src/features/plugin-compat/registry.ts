/**
 * OpenClaw 兼容钩子注册表
 *
 * 管理兼容插件的钩子注册和执行
 * 遵循 OpenClaw 优先级规则：priority 数值越大越先执行
 */

import type {
  RegisteredCompatHook,
  CompatHookName,
  CompatHookHandlerMap,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
} from './types.js';

/**
 * 兼容钩子注册表
 */
export class CompatHookRegistry {
  /** 钩子存储：hookName -> 按优先级排序的钩子列表 */
  private hooks = new Map<CompatHookName, RegisteredCompatHook[]>();

  /**
   * 注册钩子
   *
   * @param hookName 钩子名称
   * @param handler 钩子处理器
   * @param priority 优先级（数值越大越先执行）
   * @param pluginId 插件 ID
   */
  register<K extends CompatHookName>(
    hookName: K,
    handler: CompatHookHandlerMap[K],
    priority: number,
    pluginId: string
  ): void {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }

    const hooks = this.hooks.get(hookName)!;
    hooks.push({
      pluginId,
      hookName,
      handler,
      priority,
    });

    // 按 priority 降序排序（数值越大越先执行）
    hooks.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取指定钩子的所有处理器（按优先级排序）
   *
   * @param hookName 钩子名称
   * @returns 钩子列表
   */
  get(hookName: CompatHookName): RegisteredCompatHook[] {
    return this.hooks.get(hookName) || [];
  }

  /**
   * 检查是否有指定钩子
   *
   * @param hookName 钩子名称
   * @returns 是否存在
   */
  has(hookName: CompatHookName): boolean {
    const hooks = this.hooks.get(hookName);
    return hooks !== undefined && hooks.length > 0;
  }

  /**
   * 执行 before_tool_call 钩子
   *
   * 按优先级顺序执行：
   * - 如果任何钩子返回 block=true，则立即阻止执行
   * - 多个插件的参数修改会累积合并
   *
   * @param context 钩子上下文
   * @returns 钩子执行结果（如果任何钩子返回 block=true，则阻止执行）
   */
  async executeBeforeToolCall(context: BeforeToolCallContext): Promise<BeforeToolCallResult> {
    const hooks = this.get('before_tool_call');
    let accumulatedParams: Record<string, unknown> | undefined;

    for (const { handler, pluginId } of hooks) {
      try {
        const result = await (handler as (ctx: BeforeToolCallContext) => BeforeToolCallResult | Promise<BeforeToolCallResult>)(context);

        // 检查阻断
        if (result?.block) {
          return {
            block: true,
            denyReason: result.denyReason || `Blocked by plugin: ${pluginId}`,
          };
        }

        // 累积参数修改（后面的插件可以覆盖前面的）
        if (result?.rewrittenParameters) {
          if (!accumulatedParams) {
            accumulatedParams = { ...result.rewrittenParameters };
          } else {
            // 深度合并参数
            accumulatedParams = this.deepMerge(accumulatedParams, result.rewrittenParameters);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[CompatHook] before_tool_call in ${pluginId} failed: ${message}`);
        // 继续执行下一个钩子
      }
    }

    // 返回累积的参数修改（如果有）
    if (accumulatedParams) {
      return { block: false, rewrittenParameters: accumulatedParams };
    }

    // 没有钩子返回 block，允许执行
    return { block: false };
  }

  /**
   * 深度合并对象
   */
  private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };

    for (const [key, value] of Object.entries(source)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const targetValue = result[key];
        if (targetValue !== null && typeof targetValue === 'object' && !Array.isArray(targetValue)) {
          result[key] = this.deepMerge(targetValue as Record<string, unknown>, value as Record<string, unknown>);
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 执行 after_tool_call 钩子
   *
   * 按优先级顺序执行所有钩子（void 返回值）
   *
   * @param context 钩子上下文
   */
  async executeAfterToolCall(context: AfterToolCallContext): Promise<void> {
    const hooks = this.get('after_tool_call');

    for (const { handler, pluginId } of hooks) {
      try {
        await (handler as (ctx: AfterToolCallContext) => void | Promise<void>)(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[CompatHook] after_tool_call in ${pluginId} failed: ${message}`);
        // 继续执行下一个钩子
      }
    }
  }

  /**
   * 获取所有已注册的钩子信息
   *
   * @returns 钩子信息映射
   */
  getHooksInfo(): Map<CompatHookName, Array<{ pluginId: string; priority: number }>> {
    const info = new Map<CompatHookName, Array<{ pluginId: string; priority: number }>>();

    for (const [hookName, hooks] of this.hooks.entries()) {
      info.set(hookName, hooks.map(h => ({ pluginId: h.pluginId, priority: h.priority })));
    }

    return info;
  }

  /**
   * 清空所有钩子
   */
  clear(): void {
    this.hooks.clear();
  }

  /**
   * 获取钩子总数
   */
  get size(): number {
    let total = 0;
    for (const hooks of this.hooks.values()) {
      total += hooks.length;
    }
    return total;
  }
}
