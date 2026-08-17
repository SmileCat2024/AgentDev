/**
 * 静态钩子声明（三原语）
 *
 * 工作项 A1：钩子 kind 由作者在类定义时静态声明，替代 lifecycle 硬编码推导。
 *
 * Feature 类通过静态属性声明反向钩子：
 *
 * ```typescript
 * class MyFeature implements AgentFeature {
 *   name = 'my-feature';
 *   static hooks: HookDeclarations = {
 *     beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
 *     onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
 *   };
 *   beforeTool(ctx: ToolContext) { return Decision.Continue; }
 *   onStepStart(ctx: StepStartContext): void {}
 * }
 * ```
 *
 * 设计约束（战略文档 §4.A）：
 * - 不使用 @ 装饰器：Claw 预制 agent 为纯 .js 无法消费装饰器；
 *   静态声明对 JS/TS 等价、零运行时依赖，且装配时静态可读。
 * - 这是装配预检（工作项 D）能查的东西：声明可在不实例化消费路径的情况下校验。
 */

import { CoreLifecycle, type DecisionResult } from './lifecycle.js';
import type {
  AgentInitiateContext,
  AgentDestroyContext,
  CallStartContext,
  CallFinishContext,
  StepStartContext,
  ToolContext,
  ToolFinishedDecisionContext,
  StepFinishDecisionContext,
  ToolResultTransformContext,
} from './lifecycle.js';
import type { AgentFeature } from './feature.js';
import type { ToolExecResult } from './context.js';

// ========== 类型定义 ==========

/** 三原语：观察 / 拦截 / 改写 */
export type HookKind = 'observe' | 'guard' | 'transform';

/** guard 钩子角色：policy（策略方，先执行）| advisor（顾问方，后执行） */
export type GuardRole = 'policy' | 'advisor';

/** 单个钩子的静态声明 */
export interface HookDeclaration {
  /** 挂载的生命周期 */
  lifecycle: CoreLifecycle;
  /** 原语类型 */
  kind: HookKind;
  /**
   * guard 角色，仅 kind === 'guard' 时合法。
   * 未声明时默认 'advisor'。一次装配中 policy 至多一个。
   */
  role?: GuardRole;
}

/** 方法名 → 声明 */
export type HookDeclarations = Record<string, HookDeclaration>;

/** 结构化校验问题（供装配预检与运行时注册共用，不乱命名） */
export type HookDeclarationIssueCode =
  | 'method_missing'
  | 'method_not_function'
  | 'invalid_kind'
  | 'invalid_lifecycle'
  | 'invalid_kind_lifecycle'
  | 'role_on_non_guard'
  | 'duplicate_policy';

export interface HookDeclarationIssue {
  feature: string;
  method: string;
  code: HookDeclarationIssueCode;
  /** 含修复建议的完整描述 */
  message: string;
}

// ========== kind 与 lifecycle 的合法组合 ==========
//
// guard 只出现在有流程控制能力的生命周期（ToolUse / StepFinish）；
// transform 只出现在 ToolResultTransform；
// observe 可挂在任意生命周期。

const GUARD_LIFECYCLES = new Set<CoreLifecycle>([
  CoreLifecycle.ToolUse,
  CoreLifecycle.StepFinish,
]);

const TRANSFORM_LIFECYCLES = new Set<CoreLifecycle>([
  CoreLifecycle.ToolResultTransform,
]);

const VALID_KINDS = new Set<HookKind>(['observe', 'guard', 'transform']);
const VALID_ROLES = new Set<GuardRole>(['policy', 'advisor']);

// ========== 读取 ==========

/**
 * 读取 Feature 的静态钩子声明（含默认值补齐）。
 *
 * 无声明的 Feature 返回空对象（走装饰器回退路径，由 HooksRegistry 处理）。
 */
export function readHookDeclarations(feature: AgentFeature): HookDeclarations {
  const raw = (feature.constructor as any)?.hooks;
  if (!raw || typeof raw !== 'object') return {};

  const result: HookDeclarations = {};
  for (const [method, decl] of Object.entries(raw as Record<string, HookDeclaration>)) {
    if (!decl || typeof decl !== 'object') continue;
    result[method] = {
      lifecycle: decl.lifecycle,
      kind: decl.kind,
      // guard 未声明 role 时默认 advisor；
      // 非 guard 上的 role 原样保留（哪怕非法）——校验器需要看到它才能报告 role_on_non_guard
      role: decl.kind === 'guard' ? (decl.role ?? 'advisor') : decl.role,
    };
  }
  return result;
}

// ========== 校验 ==========

/**
 * 校验单个 Feature 的静态声明。
 *
 * 返回问题列表；空数组 = 通过。
 * 每个问题都是结构化的（feature/method/code），供装配预检直接消费。
 */
export function validateHookDeclarations(feature: AgentFeature): HookDeclarationIssue[] {
  const declarations = readHookDeclarations(feature);
  if (Object.keys(declarations).length === 0) return [];

  const issues: HookDeclarationIssue[] = [];
  const featureName = feature.name;

  for (const [method, decl] of Object.entries(declarations)) {
    // 方法存在性与类型
    const value = (feature as any)[method];
    if (value === undefined) {
      issues.push({
        feature: featureName,
        method,
        code: 'method_missing',
        message: `Feature '${featureName}' 的钩子声明 '${method}' 指向的方法不存在。修复：在类中实现该方法，或从 static hooks 中删除该声明。`,
      });
      continue;
    }
    if (typeof value !== 'function') {
      issues.push({
        feature: featureName,
        method,
        code: 'method_not_function',
        message: `Feature '${featureName}' 的钩子声明 '${method}' 指向的成员不是函数（实际为 ${typeof value}）。修复：将该成员改为方法。`,
      });
      continue;
    }

    // kind 合法性
    if (!VALID_KINDS.has(decl.kind)) {
      issues.push({
        feature: featureName,
        method,
        code: 'invalid_kind',
        message: `Feature '${featureName}' 的钩子 '${method}' 声明了非法 kind '${String(decl.kind)}'。修复：kind 只能是 'observe' | 'guard' | 'transform'。`,
      });
      continue;
    }

    // lifecycle 合法性
    if (!Object.values(CoreLifecycle).includes(decl.lifecycle)) {
      issues.push({
        feature: featureName,
        method,
        code: 'invalid_lifecycle',
        message: `Feature '${featureName}' 的钩子 '${method}' 声明了非法 lifecycle '${String(decl.lifecycle)}'。修复：使用 CoreLifecycle 枚举值。`,
      });
      continue;
    }

    // role 只允许出现在 guard 上
    if (decl.role !== undefined && decl.kind !== 'guard') {
      issues.push({
        feature: featureName,
        method,
        code: 'role_on_non_guard',
        message: `Feature '${featureName}' 的钩子 '${method}'（kind='${decl.kind}'）声明了 role '${decl.role}'。修复：role 仅对 kind='guard' 合法，请删除 role 字段。`,
      });
    }

    // guard role 值合法性（默认补齐后 guard 一定有 role）
    if (decl.kind === 'guard' && decl.role !== undefined && !VALID_ROLES.has(decl.role)) {
      issues.push({
        feature: featureName,
        method,
        code: 'invalid_kind',
        message: `Feature '${featureName}' 的 guard 钩子 '${method}' 声明了非法 role '${String(decl.role)}'。修复：role 只能是 'policy' | 'advisor'。`,
      });
    }

    // kind 与 lifecycle 的合法组合
    const lifecycleValid =
      decl.kind === 'guard'
        ? GUARD_LIFECYCLES.has(decl.lifecycle)
        : decl.kind === 'transform'
          ? TRANSFORM_LIFECYCLES.has(decl.lifecycle)
          : true; // observe 任意 lifecycle
    if (!lifecycleValid) {
      const expected =
        decl.kind === 'guard'
          ? 'ToolUse / StepFinish'
          : 'ToolResultTransform';
      issues.push({
        feature: featureName,
        method,
        code: 'invalid_kind_lifecycle',
        message: `Feature '${featureName}' 的钩子 '${method}'：kind='${decl.kind}' 不能挂在 lifecycle '${decl.lifecycle}' 上（合法值：${expected}）。修复：更换 kind 或 lifecycle 使组合合法。`,
      });
    }
  }

  return issues;
}

/**
 * 装配级校验：一次装配中每个 lifecycle 的 policy 至多一个。
 *
 * 两个 policy 意味着策略裁决权分裂——这是装配错误，
 * 必须在装配时报出（报名报错），不许运行时碰运气。
 */
export function validatePolicyUniqueness(features: AgentFeature[]): HookDeclarationIssue[] {
  const issues: HookDeclarationIssue[] = [];

  // lifecycle → policy 声明列表
  const policiesByLifecycle = new Map<CoreLifecycle, Array<{ feature: string; method: string }>>();

  for (const feature of features) {
    const declarations = readHookDeclarations(feature);
    for (const [method, decl] of Object.entries(declarations)) {
      if (decl.kind !== 'guard' || decl.role !== 'policy') continue;
      if (!GUARD_LIFECYCLES.has(decl.lifecycle)) continue; // 组合非法由单 feature 校验报告
      const list = policiesByLifecycle.get(decl.lifecycle) ?? [];
      list.push({ feature: feature.name, method });
      policiesByLifecycle.set(decl.lifecycle, list);
    }
  }

  for (const [lifecycle, list] of policiesByLifecycle) {
    if (list.length <= 1) continue;
    const names = list.map(p => `'${p.feature}#${p.method}'`).join('、');
    issues.push({
      feature: list[0].feature,
      method: list[0].method,
      code: 'duplicate_policy',
      message: `lifecycle '${lifecycle}' 上出现了 ${list.length} 个 policy guard：${names}。一次装配中每个 lifecycle 至多一个 policy。修复：保留一个 policy，其余改为 role: 'advisor'（advisor 在 policy 之后执行，不具裁决优先权）。`,
    });
  }

  return issues;
}

/**
 * 将问题列表转成单一 Error（运行时注册路径使用）。
 */
export function issuesToError(issues: HookDeclarationIssue[]): Error {
  const lines = issues.map(i => `[${i.code}] ${i.message}`);
  return new Error(`钩子声明校验失败（${issues.length} 个问题）：\n${lines.join('\n')}`);
}

// ========== 钩子方法类型别名 ==========

/**
 * 反向钩子方法类型（供声明方法的签名标注使用）
 */
type HookMethod<TContext, TReturn> = (ctx: TContext) => TReturn;

export type AgentInitiateHook = HookMethod<AgentInitiateContext, void | Promise<void>>;
export type AgentDestroyHook = HookMethod<AgentDestroyContext, void | Promise<void>>;
export type CallStartHook = HookMethod<CallStartContext, void | Promise<void>>;
export type CallFinishHook = HookMethod<CallFinishContext, void | Promise<void>>;
export type StepStartHook = HookMethod<StepStartContext, void | Promise<void>>;
export type StepFinishHook = HookMethod<StepFinishDecisionContext, DecisionResult | Promise<DecisionResult>>;
export type ToolUseHook = HookMethod<ToolContext, DecisionResult | Promise<DecisionResult>>;
export type ToolFinishedHook = HookMethod<ToolFinishedDecisionContext, void | Promise<void>>;
export type ToolResultTransformHook = HookMethod<
  ToolResultTransformContext,
  ToolExecResult | undefined | Promise<ToolExecResult | undefined>
>;
