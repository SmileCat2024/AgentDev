/**
 * SubAgent Feature - 子代理功能模块
 *
 * 提供子代理创建、管理、消息回传等完整能力
 *
 * 重构说明：
 * - 使用装饰器实现反向钩子
 * - 移除旧的方法（handleNoToolCalls, handleWait, consumeMessages）
 * - 通过 @ToolFinished 和 @StepFinish 装饰器实现子代理等待机制
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Agent } from '../../core/agent.js';
import type { Context } from '../../core/context.js';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  ContextInjector,
  FeatureStateSnapshot,
  PackageInfo,
} from '../../core/feature.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import type { ToolCall } from '../../core/types.js';
import type { SubAgentStatus } from '../../core/lifecycle.js';
import {
  ToolFinished,
  StepFinish,
} from '../../core/hooks-decorator.js';
import type { ToolFinishedHook, StepFinishHook } from '../../core/hooks-decorator.js';
import type { ToolFinishedDecisionContext, StepFinishDecisionContext } from '../../core/lifecycle.js';
import { Decision } from '../../core/lifecycle.js';
import { AgentPool } from './pool.js';
import { SubAgentToolFactory } from './tools.js';

// ESM 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ========== SubAgent Feature ==========

/**
 * 子代理 Feature
 *
 * 提供子代理创建、管理、消息回传等完整能力
 *
 * 重构说明：
 * - 使用装饰器实现反向钩子
 * - @ToolFinished: 处理 wait 工具完成后的等待逻辑
 * - @StepFinish: 处理无工具调用时的子代理等待逻辑
 */
export class SubAgentFeature implements AgentFeature {
  readonly name = 'subagent';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '提供子代理创建、等待与消息回传能力，让主循环可以协同多个代理工作。';

  private agentPool?: AgentPool;
  private parentAgent?: Agent;

  // 工具工厂实例
  private toolFactory?: SubAgentToolFactory;

  /**
   * 缓存包信息
   */
  private _packageInfo: PackageInfo | null = null;

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   */
  getTemplateNames(): string[] {
    return [
      'agent-spawn',
      'agent-list',
      'agent-send',
      'agent-close',
      'wait',
    ];
  }

  constructor() {
    // 无参数配置（可扩展）
  }

  /**
   * 获取 AgentPool（供外部访问）
   */
  get pool(): AgentPool | undefined {
    return this.agentPool;
  }

  // ========== AgentFeature 接口实现 ==========

  /**
   * 初始化钩子
   */
  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    // 工具工厂在 _setParentAgent 中初始化
  }

  /**
   * 设置父代理引用（由 Agent 在 use() 时调用）
   */
  _setParentAgent(agent: Agent): void {
    this.parentAgent = agent;
    this.agentPool = new AgentPool(agent);

    // 初始化工具工厂
    this.toolFactory = new SubAgentToolFactory({
      getPool: () => {
        if (!this.agentPool) throw new Error('AgentPool not initialized');
        return this.agentPool;
      },
      getParentAgent: () => this.parentAgent,
    });
  }

  /**
   * 获取同步工具
   */
  getTools(): Tool[] {
    return this.toolFactory?.getAllTools() || [];
  }

  getContextInjectors(): Map<string | RegExp, ContextInjector> {
    return new Map([
      ['spawn_agent', () => ({ parentAgent: this.parentAgent })],
      ['list_agents', () => ({ parentAgent: this.parentAgent })],
      ['send_to_agent', () => ({ parentAgent: this.parentAgent })],
      ['close_agent', () => ({ parentAgent: this.parentAgent })],
      ['wait', () => ({ parentAgent: this.parentAgent })],
    ]);
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'ToolFinished' && methodName === 'handleWaitTool') {
      return '在 wait 工具结束后阻塞等待子代理消息，并把结果回填到主代理上下文。';
    }
    if (lifecycle === 'StepFinish' && methodName === 'handleNoToolCalls') {
      return '当本轮没有工具调用但仍有活跃子代理时，等待回信并强制继续下一轮 ReAct。';
    }
    return undefined;
  }

  // ========== 反向钩子（使用装饰器）==========

  /**
   * 处理 wait 工具
   *
   * 触发时机：wait 工具执行完成后
   * 处理逻辑：
   * 1. 检测刚才执行的工具是否是 wait
   * 2. 如果不是，直接返回（不处理）
   * 3. 如果是，检查是否有 busy 状态的子代理
   * 4. 如果有，调用 agentPool.waitForMessage() 阻塞等待（await 阻塞主循环）
   * 5. 消息插入到主代理 context
   *
   * 注意：这是纯通知钩子（void），流程控制通过 await 阻塞实现
   */
  @ToolFinished
  async handleWaitTool(ctx: ToolFinishedDecisionContext): Promise<void> {
    // 1. 只处理 wait 工具
    if (ctx.toolName !== 'wait') {
      return;
    }

    // 2. 检查是否有 busy 子代理
    if (!this.agentPool?.hasActiveAgents()) {
      return;
    }

    // 3. 阻塞等待（await 本身就会让主循环等待）
    const result = await this.agentPool.waitForMessage();

    // 4. 消息插入到 context
    ctx.context.add({
      role: 'assistant',
      content: `[子代理 ${result.agentId} 执行完成]:\n\n${result.message}`,
    });
  }

  /**
   * 处理无工具调用时的子代理等待
   *
   * 触发时机：Step 结束时
   * 处理逻辑：
   * 1. 检查是否有 busy 状态的子代理
   * 2. 如果没有，返回 Continue（正常结束）
   * 3. 如果有，调用 agentPool.waitForMessage() 阻塞等待
   * 4. 消息插入到主代理 context
   * 5. 返回 Approve（重启 ReAct 循环）
   */
  @StepFinish
  async handleNoToolCalls(ctx: StepFinishDecisionContext): Promise<import('../../core/hooks-decorator.js').DecisionResult> {
    // 只在无工具调用时处理
    if (ctx.llmResponse.toolCalls && ctx.llmResponse.toolCalls.length > 0) {
      return Decision.Continue;
    }

    // 1. 检查是否有活跃子代理
    if (!this.agentPool?.hasActiveAgents()) {
      return Decision.Continue;
    }

    // 2. 阻塞等待
    const result = await this.agentPool.waitForMessage();

    // 3. 消息插入到 context
    ctx.context.add({
      role: 'assistant',
      content: `[子代理 ${result.agentId} 执行完成]:\n\n${result.message}`,
    });

    // 4. 重启 ReAct 循环
    return Decision.Approve;
  }

  async onDestroy(): Promise<void> {
    return this.agentPool?.shutdown() ?? Promise.resolve();
  }

  captureState(): FeatureStateSnapshot {
    const runtime = this.agentPool?.getRuntimeSnapshot();
    return {
      counters: runtime?.counters ?? [],
      hadInstances: (runtime?.instances.length ?? 0) > 0,
      hadActiveAgents: runtime?.instances.some(instance => instance.status === 'busy') ?? false,
      hadPendingMessages: runtime?.pendingMessages.some(([, messages]) => messages.length > 0) ?? false,
    };
  }

  async restoreState(snapshot: FeatureStateSnapshot): Promise<void> {
    if (!this.agentPool) {
      return;
    }

    const state = snapshot as {
      counters?: Array<[string, number]>;
      hadInstances?: boolean;
      hadActiveAgents?: boolean;
      hadPendingMessages?: boolean;
    };

    await this.agentPool.restoreRuntimeSnapshot({
      counters: state.counters,
    });

    if (state.hadInstances || state.hadActiveAgents || state.hadPendingMessages) {
      console.warn(
        '[SubAgentFeature] Restored session/rollback snapshot dropped live subagent runtime. ' +
        'Subagents are not resumable and have been reset to an empty pool.'
      );
    }
  }
}

// 重新导出 AgentPool
export { AgentPool };
