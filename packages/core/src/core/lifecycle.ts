/**
 * 生命周期类型定义
 * 定义 Agent 生命周期钩子相关的类型
 */

import type { ToolCall, Tool, LLMResponse } from './types.js';
import { type Context, type ToolExecResult } from './context.js';
import type { Agent } from './agent.js';
import type { AgentFeature } from './feature.js';

// ========== 概念定义 ==========
/**
 * Call（调用）: 用户一次完整的输入-输出交互
 * - 用户输入 → Agent 处理（可能包含多个 ReAct 步骤） → 返回最终输出
 * - 一个 Call 可能包含多个 Step
 *
 * Step（步骤）: ReAct 循环中的单次迭代
 * - 一次 LLM 调用 + 工具执行（如果有）
 * - Step 是 Call 内部的执行单元
 *
 * Turn（轮）: 从无工具调用开始，到下一次无工具调用结束的完整对话周期
 * - 可能包含多个 Step
 * - 用于反向钩子决策点
 */

// ========== 核心生命周期枚举 ==========
/**
 * 核心生命周期枚举
 *
 * 三级结构：Agent 级 > Call 级 > Step 级 > Tool 级
 * 每个生命周期都有配套的正向钩子（通知）和反向钩子（决策/处理）
 */
export enum CoreLifecycle {
  // ========== Agent 级 ==========
  /** Agent 初始化 */
  AgentInitiate = 'AgentInitiate',

  /** Agent 销毁 */
  AgentDestroy = 'AgentDestroy',

  // ========== Call 级 ==========
  /** Call 开始 */
  CallStart = 'CallStart',

  /** Call 结束 */
  CallFinish = 'CallFinish',

  // ========== Step 级 ==========
  /** Step 开始 */
  StepStart = 'StepStart',

  /** Step 结束 */
  StepFinish = 'StepFinish',

  // ========== Tool 级 ==========
  /** 工具使用前 */
  ToolUse = 'ToolUse',

  /** 工具使用后 */
  ToolFinished = 'ToolFinished',

  /** 工具结果变换（结果写入 context 前，可修改结果） */
  ToolResultTransform = 'ToolResultTransform',
}

// ========== 决策状态定义 ==========
/**
 * 决策状态（反向钩子返回值）
 *
 * 用于控制执行流程的三个状态
 */
export enum Decision {
  /** 批准：确认执行，跳过后续决策 */
  Approve = 'approve',

  /** 拒绝：阻止执行，跳过后续决策 */
  Deny = 'deny',

  /** 继续：交给下一个决策节点，使用默认行为 */
  Continue = 'continue',
}

/**
 * 决策结果类型
 */
export type DecisionResult =
  | Decision
  | {
      /** 决策动作 */
      action: Decision;

      /** 拒绝原因（用于日志/调试） */
      reason?: string;

      /** 附加元数据 */
      metadata?: Record<string, any>;
    };

/**
 * 将 DecisionResult 转换为标准 Decision
 */
export function normalizeDecision(result: DecisionResult): Decision {
  if (typeof result === 'string') {
    return result;
  }
  return result.action;
}

// ========== Agent 级别 ==========

/**
 * Agent 初始化上下文
 */
export interface AgentInitiateContext {
  /** 消息上下文 */
  context: Context;
}

/**
 * Agent 销毁上下文
 */
export interface AgentDestroyContext {
  /** 消息上下文 */
  context: Context;
}

// ========== Call 级别 ==========

/**
 * Call 开始上下文
 */
export interface CallStartContext {
  /** 用户输入 */
  input: string;
  /** 消息上下文 */
  context: Context;
  /** 是否首次调用 */
  isFirstCall: boolean;
  /** Agent 实例（用于访问 setUserInput/getUserInput 等 API） */
  agent?: any;
}

/**
 * 执行单元的终态。它只表达执行是否完成、失败、取消或移交给后续单元；
 * 不复用模型厂商的 stop reason，也不推断宿主任务的业务状态。
 */
export type ExecutionStatus = 'completed' | 'failed' | 'cancelled' | 'continued';

/**
 * 执行终止的框架级原因。
 *
 * `reason` 描述生命周期语义，错误来源由 `error.category` 表达，避免一个字段
 * 同时承担供应商协议、框架控制流和宿主业务状态三种含义。
 */
export type ExecutionReason =
  | 'completed'
  | 'cancelled'
  | 'limit_reached'
  | 'continued'
  | 'error';

/** 可序列化的错误事实。category 是稳定的机器分类，message 只供展示。 */
export interface ExecutionError {
  category: string;
  message: string;
  code?: string;
  statusCode?: number;
  retryable?: boolean;
}

/** 单次模型请求的来源信息；不决定 Call 的终态。 */
export interface ModelRequestOutcome {
  providerStopReason?: string | null;
}

/**
 * 一次 Agent Call（而非宿主任务）的结构化终态。
 * 该对象可安全持久化、跨进程传输和用于 JSONL/CLI 消费。
 */
export interface CallOutcome {
  status: ExecutionStatus;
  reason: ExecutionReason;
  response: string;
  steps: number;
  startedAt: number;
  finishedAt: number;
  error?: ExecutionError;
  model?: ModelRequestOutcome;
}

/** @deprecated 使用 CallOutcome.reason。保留旧 hook/API 的类型兼容。 */
export type CallFinishReason = ExecutionReason;

/**
 * Call 结束上下文
 */
export interface CallFinishContext {
  /** 用户输入 */
  input: string;
  /** 消息上下文 */
  context: Context;
  /** 最终响应 */
  response: string;
  /** 执行的步骤数 */
  steps: number;
  /** 是否成功完成 */
  completed: boolean;
  /** 结束原因 */
  finishReason: CallFinishReason;
  /** 完整的结构化终态 */
  outcome: CallOutcome;
}

// ========== Step 级别 ==========

/**
 * Step 开始上下文
 *
 * Step 是 ReAct 循环中的单次迭代
 */
export interface StepStartContext {
  /** 当前步骤序号（从 0 开始） */
  step: number;
  /** 当前调用序号（用户交互次数，从 0 开始） */
  callIndex: number;
  /** 消息上下文 */
  context: Context;
  /** 原始用户输入 */
  input: string;
  /** Agent 实例（用于访问当前会话中的 Feature、工具和输入状态） */
  agent?: any;
}

/**
 * Step 结束上下文
 */
export interface StepFinishedContext extends StepStartContext {
  /** LLM 响应 */
  llmResponse: LLMResponse;
  /** 执行的工具调用数量 */
  toolCallsCount: number;
}

// ========== Tool 级别 ==========

/**
 * 工具上下文 - onToolUse 钩子的参数
 *
 * 提供工具调用时的完整上下文信息
 */
export interface ToolContext {
  /** 工具调用 */
  call: ToolCall;
  /** 工具定义 */
  tool: Tool;
  /** 当前步骤序号 */
  step: number;
  /** 用户输入 */
  input: string;
  /** 消息上下文（可读写） */
  context: Context;
  /** 获取其他 Feature */
  getFeature<T extends AgentFeature>(name: string): T | undefined;
}

/**
 * 工具结果 - onToolFinished 钩子的参数
 *
 * 提供工具执行后的完整结果信息
 */
export interface ToolResult {
  /** 是否成功 */
  success: boolean;
  /** 经过 ToolResultTransform 后、实际写入模型上下文的最终结果。 */
  delivered?: ToolExecResult;
  /** 返回数据 */
  data: unknown;
  /** 错误信息（如果失败） */
  error?: string;
  /** 执行耗时(ms) */
  duration: number;
  /** 工具调用 */
  call: ToolCall;
  /** 工具定义 */
  tool: Tool;
  /** 当前步骤序号 */
  step: number;
  /** 用户输入 */
  input: string;
  /** 消息上下文 */
  context: Context;
  /** 获取其他 Feature */
  getFeature<T extends AgentFeature>(name: string): T | undefined;
}

/**
 * 钩子返回值类型（扩展版）
 *
 * 统一的生命周期钩子控制流指令
 *
 * - { action: 'block' }: 阻止工具执行（工具级）
 * - { action: 'allow' }: 允许工具执行（工具级）
 * - undefined: 默认行为
 */
export type HookResult =
  | { action: 'block'; reason?: string }
  | { action: 'allow' }
  | undefined;

// ========== SubAgent 级别 ==========

/**
 * 子代理状态
 */
export type SubAgentStatus = 'idle' | 'busy' | 'completed' | 'failed' | 'terminated';

/**
 * 子代理创建上下文
 */
export interface SubAgentSpawnContext {
  /** 子代理 ID */
  agentId: string;
  /** 子代理类型 */
  type: string;
  /** 初始指令 */
  instruction: string;
  /** 子代理实例 */
  agent: Agent;
}

/**
 * 子代理状态更新上下文
 */
export interface SubAgentUpdateContext {
  /** 子代理 ID */
  agentId: string;
  /** 子代理类型 */
  type: string;
  /** 旧状态 */
  oldStatus: SubAgentStatus;
  /** 新状态 */
  newStatus: SubAgentStatus;
  /** 执行结果（完成时） */
  result?: string;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 子代理销毁上下文
 */
export interface SubAgentDestroyContext {
  /** 子代理 ID */
  agentId: string;
  /** 子代理类型 */
  type: string;
  /** 销毁原因 */
  reason: 'manual' | 'parent_dispose' | 'error';
}

/**
 * Agent 中断上下文
 */
export interface AgentInterruptContext {
  /** 中断原因 */
  reason: 'limit_reached' | 'error' | 'cancelled';
  /** 当前步骤序号 */
  step: number;
  /** 当前消息上下文 */
  context: Context;
}

/**
 * 子代理中断上下文
 */
export interface SubAgentInterruptContext {
  /** 子代理 ID */
  agentId: string;
  /** 子代理类型 */
  type: string;
  /** 中断原因 */
  reason: 'limit_reached' | 'error' | 'cancelled';
  /** 中断时的结果 */
  result: string;
}

// ========== 决策上下文类型（反向钩子专用）==========

/**
 * Step 结束决策上下文（反向钩子）
 *
 * 用于在 Step 结束后进行流程控制决策
 */
export interface StepFinishDecisionContext extends StepFinishedContext {
  /** 是否有活跃的子代理（busy 状态） */
  hasActiveSubAgents?: boolean;

  /** 是否有待处理的子代理消息 */
  hasPendingMessages?: boolean;

  /** 是否调用了 wait 工具 */
  waitCalled?: boolean;
}

/**
 * 工具完成决策上下文（反向钩子）
 *
 * 用于在工具执行完成后进行流程控制决策
 */
export interface ToolFinishedDecisionContext extends ToolResult {
  /** 刚才执行的工具名称 */
  toolName: string;
}

/**
 * 工具结果变换上下文（反向钩子）
 *
 * 在工具执行完成、结果写入 context 之前，允许 Feature 对结果进行变换。
 * 典型用途：输出截断（OutputGuard）、脱敏、格式清理等。
 *
 * 钩子返回 undefined 表示不修改；返回 ToolExecResult 表示用新结果替换。
 * 多个钩子按注册顺序链式执行，前一个钩子的输出作为后一个钩子的输入。
 */
export interface ToolResultTransformContext {
  /** 工具名称 */
  toolName: string;
  /** 工具调用 */
  call: ToolCall;
  /** 当前结果（可能已被前一个变换钩子修改） */
  result: ToolExecResult;
  /** 当前步骤序号 */
  step: number;
}
