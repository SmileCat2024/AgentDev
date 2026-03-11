/**
 * 反向钩子装饰器
 *
 * 使用装饰器标记反向钩子方法，提供编译时和运行时类型检查
 */

import { CoreLifecycle, Decision, DecisionResult } from './lifecycle.js';
import type { HookSourceLocation } from './types.js';
import type {
  AgentInitiateContext,
  AgentDestroyContext,
  CallStartContext,
  CallFinishContext,
  StepStartContext,
  StepFinishedContext,
  ToolContext,
  ToolResult,
  StepFinishDecisionContext,
  ToolFinishedDecisionContext,
} from './lifecycle.js';

// ========== 装饰器元数据 ==========

/**
 * 装饰器元数据存储
 *
 * 存储在类的构造函数上，记录哪些方法被标记为反向钩子
 */
interface DecoratorMetadata {
  /** 生命周期 → 方法名 映射 */
  hookDecisions: Map<CoreLifecycle, string>;
  /** 生命周期:方法名 → 源码位置 */
  hookSources: Map<string, HookSourceLocation>;
  /** 生命周期 → 方法签名 映射 */
  hookSignatures: Map<CoreLifecycle, {
    contextType: string;
    returnType: string;
  }>;
}

// ========== 上下文类型映射 ==========

/**
 * 反向钩子上下文类型映射
 *
 * 每个生命周期对应的决策上下文类型
 */
const DecisionContextTypeMap: Record<CoreLifecycle, string> = {
  [CoreLifecycle.AgentInitiate]: 'AgentInitiateContext',
  [CoreLifecycle.AgentDestroy]: 'AgentDestroyContext',
  [CoreLifecycle.CallStart]: 'CallStartContext',
  [CoreLifecycle.CallFinish]: 'CallFinishContext',
  [CoreLifecycle.StepStart]: 'StepStartContext',
  [CoreLifecycle.StepFinish]: 'StepFinishDecisionContext',
  [CoreLifecycle.ToolUse]: 'ToolContext',
  [CoreLifecycle.ToolFinished]: 'ToolFinishedDecisionContext',
};

// ========== 返回值类型映射 ==========

/**
 * 反向钩子返回值类型映射
 *
 * 每个生命周期对应的返回值类型
 * - 'void': 无返回值或 undefined（仅做处理，不控制流程）
 * - 'DecisionResult': 返回决策结果（有流程控制能力）
 */
const DecisionReturnTypeMap: Record<CoreLifecycle, 'void' | 'DecisionResult'> = {
  [CoreLifecycle.AgentInitiate]: 'void',
  [CoreLifecycle.AgentDestroy]: 'void',
  [CoreLifecycle.CallStart]: 'void',
  [CoreLifecycle.CallFinish]: 'void',
  [CoreLifecycle.StepStart]: 'void',
  [CoreLifecycle.StepFinish]: 'DecisionResult',  // Step 结束时可以决定是否继续循环
  [CoreLifecycle.ToolUse]: 'DecisionResult',      // 工具使用前可以决定是否阻塞执行
  [CoreLifecycle.ToolFinished]: 'void',           // 工具完成后仅做通知（无流程控制）
};

/**
 * 流程控制型钩子集合
 *
 * 这些钩子返回 DecisionResult，在单个 Feature 内只能使用一次
 */
const DECISION_HOOKS = new Set<CoreLifecycle>([
  CoreLifecycle.StepFinish,
  CoreLifecycle.ToolUse,      // 工具执行前可阻塞
]);

function normalizeSourceFile(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\/dist\//, '/src/')
    .replace(/\.js$/, '.ts');
}

function captureDecoratorSource(): HookSourceLocation | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;

  const lines = stack.split('\n').slice(1);
  for (const line of lines) {
    if (
      line.includes('hooks-decorator.') ||
      line.includes('__decorate') ||
      line.includes('Reflect.decorate')
    ) {
      continue;
    }

    const match = line.match(/\(?(.+?):(\d+):(\d+)\)?$/);
    if (!match) continue;

    const [, rawFile, rawLine, rawColumn] = match;
    const file = normalizeSourceFile(rawFile.trim());
    const lineNumber = Number(rawLine);
    const columnNumber = Number(rawColumn);

    return {
      file,
      line: Number.isNaN(lineNumber) ? undefined : lineNumber,
      column: Number.isNaN(columnNumber) ? undefined : columnNumber,
      display: `${file}:${rawLine}`,
    };
  }

  return undefined;
}

// ========== 装饰器工厂 ==========

/**
 * 创建反向钩子装饰器
 *
 * @param lifecycle - 生命周期类型
 * @returns 装饰器函数
 */
function createHookDecorator(lifecycle: CoreLifecycle) {
  const expectedContext = DecisionContextTypeMap[lifecycle];
  const expectedReturn = DecisionReturnTypeMap[lifecycle];

  return function hookDecorator(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const constructor = target.constructor;

    // ========== 唯一性检查 ==========

    // 初始化元数据存储
    if (!constructor._hookDecisions) {
      constructor._hookDecisions = new Map<CoreLifecycle, string>();
    }
    if (!constructor._hookSources) {
      constructor._hookSources = new Map<string, HookSourceLocation>();
    }

    // 唯一性检查：流程控制型钩子在类中只能使用一次
    // 非流程控制型钩子（void 返回值）可以使用多次
    if (DECISION_HOOKS.has(lifecycle) && constructor._hookDecisions.has(lifecycle)) {
      throw new Error(
        `流程控制型装饰器 @${lifecycle} 在 ${constructor.name} 中只能使用一次`
      );
    }

    // 注册元数据（非流程控制型钩子允许多个方法）
    const existing = constructor._hookDecisions.get(lifecycle);
    if (existing) {
      // 追加方法名（用逗号分隔）
      constructor._hookDecisions.set(lifecycle, `${existing},${propertyKey}`);
    } else {
      constructor._hookDecisions.set(lifecycle, propertyKey);
    }

    const source = captureDecoratorSource();
    if (source) {
      constructor._hookSources.set(`${lifecycle}:${propertyKey}`, source);
    }

    // 保存期望的签名（供运行时验证）
    constructor._hookSignatures = constructor._hookSignatures || new Map();
    constructor._hookSignatures.set(lifecycle, {
      contextType: expectedContext,
      returnType: expectedReturn,
    });

    // ========== 运行时返回值验证 ==========

    if (descriptor.value && typeof descriptor.value === 'function') {
      const originalMethod = descriptor.value;
      descriptor.value = function (this: any, ...args: any[]) {
        const result = originalMethod.apply(this, args);

        // 验证返回值类型（仅在开发模式）
        if (process.env.NODE_ENV === 'development') {
          if (expectedReturn === 'void') {
            // void 类型：期望无返回值或 undefined
            if (result !== undefined) {
              console.warn(
                `[@${lifecycle}] 方法 ${propertyKey} 应该返回 void 或 undefined，` +
                `但返回了 ${typeof result}`
              );
            }
          } else {
            // DecisionResult 类型：期望 Promise<DecisionResult>
            if (!(result instanceof Promise)) {
              console.warn(
                `[@${lifecycle}] 方法 ${propertyKey} 必须返回 Promise<DecisionResult>` +
                `，但返回了 ${typeof result}`
              );
            }
          }
        }

        return result;
      };
    }

    return descriptor;
  };
}

// ========== 导出具体装饰器 ==========

/**
 * Agent 初始化装饰器
 *
 * 标记在 Agent 初始化时执行的方法
 * 返回 void（仅做处理，不控制流程）
 */
export const AgentInitiate = createHookDecorator(CoreLifecycle.AgentInitiate);

/**
 * Agent 销毁装饰器
 *
 * 标记在 Agent 销毁时执行的方法
 * 返回 void（仅做处理，不控制流程）
 */
export const AgentDestroy = createHookDecorator(CoreLifecycle.AgentDestroy);

/**
 * Call 开始装饰器
 *
 * 标记在 Call 开始时执行的方法
 * 返回 void（仅做处理，不控制流程）
 */
export const CallStart = createHookDecorator(CoreLifecycle.CallStart);

/**
 * Call 结束装饰器
 *
 * 标记在 Call 结束时执行的方法
 * 返回 void（仅做处理，不控制流程）
 */
export const CallFinish = createHookDecorator(CoreLifecycle.CallFinish);

/**
 * Step 开始装饰器
 *
 * 标记在 Step 开始时执行的方法
 * 返回 void（仅做处理，不控制流程）
 */
export const StepStart = createHookDecorator(CoreLifecycle.StepStart);

/**
 * Step 结束装饰器
 *
 * 标记在 Step 结束时执行的方法
 * 返回 DecisionResult（有流程控制能力）
 * - Decision.Approve: 继续循环（即使无工具调用）
 * - Decision.Deny: 结束循环
 * - Decision.Continue: 使用默认行为
 */
export const StepFinish = createHookDecorator(CoreLifecycle.StepFinish);

/**
 * 工具使用装饰器
 *
 * 标记在工具使用前执行的方法
 * 返回 DecisionResult（有流程控制能力）
 * - Decision.Approve: 允许工具执行
 * - Decision.Deny: 阻止工具执行（返回错误）
 * - Decision.Continue: 使用默认行为（允许执行）
 */
export const ToolUse = createHookDecorator(CoreLifecycle.ToolUse);

/**
 * 工具完成装饰器
 *
 * 标记在工具执行完成后执行的方法
 * 返回 void（仅做处理，不控制流程）
 */
export const ToolFinished = createHookDecorator(CoreLifecycle.ToolFinished);

// ========== 导出装饰器元数据访问接口 ==========

/**
 * 获取类的装饰器元数据
 *
 * @param target 类或类实例
 * @returns 装饰器元数据
 */
export function getDecoratorMetadata(target: any): DecoratorMetadata {
  const constructor = typeof target === 'function' ? target : target.constructor;
  return {
    hookDecisions: constructor._hookDecisions || new Map<CoreLifecycle, string>(),
    hookSources: constructor._hookSources || new Map<string, HookSourceLocation>(),
    hookSignatures: constructor._hookSignatures || new Map(),
  };
}

// ========== TypeScript 类型定义（编译时检查）==========

/**
 * 反向钩子方法类型
 */
type HookMethod<TContext, TReturn> = (ctx: TContext) => TReturn;

/**
 * AgentInitiate 反向钩子类型
 */
export type AgentInitiateHook = HookMethod<AgentInitiateContext, void | Promise<void>>;

/**
 * AgentDestroy 反向钩子类型
 */
export type AgentDestroyHook = HookMethod<AgentDestroyContext, void | Promise<void>>;

/**
 * CallStart 反向钩子类型
 */
export type CallStartHook = HookMethod<CallStartContext, void | Promise<void>>;

/**
 * CallFinish 反向钩子类型
 */
export type CallFinishHook = HookMethod<CallFinishContext, void | Promise<void>>;

/**
 * StepStart 反向钩子类型
 */
export type StepStartHook = HookMethod<StepStartContext, void | Promise<void>>;

/**
 * StepFinish 反向钩子类型（有流程控制）
 */
export type StepFinishHook = HookMethod<
  StepFinishDecisionContext,
  DecisionResult | Promise<DecisionResult>
>;

/**
 * ToolUse 反向钩子类型（有流程控制）
 */
export type ToolUseHook = HookMethod<
  ToolContext,
  DecisionResult | Promise<DecisionResult>
>;

/**
 * ToolFinished 反向钩子类型（仅通知）
 */
export type ToolFinishedHook = HookMethod<ToolFinishedDecisionContext, void | Promise<void>>;

// ========== 重新导出决策枚举和类型 ==========

export { CoreLifecycle, Decision, normalizeDecision } from './lifecycle.js';
export type { DecisionResult } from './lifecycle.js';
