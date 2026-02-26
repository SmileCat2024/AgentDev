/**
 * 生命周期钩子 Mixin
 *
 * 提供所有生命周期钩子的默认实现
 */

import type {
  AgentInitiateContext,
  AgentDestroyContext,
  AgentInterruptContext,
  CallStartContext,
  CallFinishContext,
  TurnStartContext,
  TurnFinishedContext,
  LLMStartContext,
  LLMFinishContext,
  SubAgentSpawnContext,
  SubAgentUpdateContext,
  SubAgentDestroyContext,
  SubAgentInterruptContext,
} from '../lifecycle.js';
import type { ToolContext, ToolResult, HookResult } from '../lifecycle.js';

/**
 * 生命周期钩子接口
 * 所有钩子都是 protected，只有子类可以访问
 */
export interface LifecycleHooks {
  onInitiate(ctx: AgentInitiateContext): Promise<void>;
  onDestroy(ctx: AgentDestroyContext): Promise<void>;
  onCallStart(ctx: CallStartContext): Promise<void>;
  onCallFinish(ctx: CallFinishContext): Promise<void>;
  onTurnStart(ctx: TurnStartContext): Promise<void>;
  onTurnFinished(ctx: TurnFinishedContext): Promise<void>;
  onLLMStart(ctx: LLMStartContext): Promise<void>;
  onLLMFinish(ctx: LLMFinishContext): Promise<void>;
  onToolUse(ctx: ToolContext): Promise<HookResult | undefined>;
  onToolFinished(result: ToolResult): Promise<void>;
  onSubAgentSpawn(ctx: SubAgentSpawnContext): Promise<void>;
  onSubAgentUpdate(ctx: SubAgentUpdateContext): Promise<void>;
  onSubAgentDestroy(ctx: SubAgentDestroyContext): Promise<void>;
  onSubAgentInterrupt(ctx: SubAgentInterruptContext): Promise<void>;
  onInterrupt(ctx: AgentInterruptContext): Promise<void>;
}
