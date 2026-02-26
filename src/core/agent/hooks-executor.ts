/**
 * 钩子执行器
 *
 * 统一的钩子执行包装器，处理错误策略
 */

// 定义 Agent 接口，包含必要的钩子错误处理方法
export interface AgentLike {
  getHookErrorHandling?(hookName: string): HookErrorHandling | undefined;
}

/**
 * 钩子错误处理策略
 */
export enum HookErrorHandling {
  /** 静默失败：记录警告，不中断主流程 */
  Silent = 'silent',
  /** 传播异常：中断整个 onCall 流程 */
  Propagate = 'propagate',
  /** 记录后传播：先记录日志再抛出 */
  Logged = 'logged',
}

/**
 * 钩子函数类型
 */
export type HookFunction<T> = () => Promise<T>;

/**
 * 钩子执行选项
 */
export interface HookExecuteOptions {
  /** 钩子名称 */
  hookName: string;
  /** 用户输入 */
  input?: string;
  /** 当前轮次 */
  turn?: number;
}

/**
 * 执行钩子并处理错误
 *
 * @param agent Agent 实例（需要调用 getHookErrorHandling）
 * @param hookFn 钩子函数
 * @param options 执行选项
 * @returns 钩子返回值，出错时返回 undefined
 */
export async function executeHook<T>(
  agent: AgentLike,
  hookFn: HookFunction<T>,
  options: HookExecuteOptions
): Promise<T | undefined> {
  const { hookName } = options;

  // 获取错误处理策略（由 Agent 实现）
  const strategy = agent.getHookErrorHandling?.(hookName) ?? HookErrorHandling.Propagate;

  try {
    return await hookFn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    switch (strategy) {
      case HookErrorHandling.Silent:
        console.warn(`[Agent] ${hookName} hook error (silenced): ${message}`);
        return undefined;
      case HookErrorHandling.Logged:
        console.error(`[Agent] ${hookName} hook error:`, error);
        throw error;
      case HookErrorHandling.Propagate:
      default:
        throw error;
    }
  }
}
