/**
 * Todo Feature - 任务列表管理功能模块
 *
 * 提供任务创建、查询、更新等能力，用于跟踪复杂任务的进度
 * 内置智能提醒功能，自动跟踪工具使用并在合适时机注入提醒
 *
 * 重构说明：
 * - 使用反向钩子装饰器实现提醒逻辑
 * - 不再需要在 Agent 中重写 onStepStart/onStepFinished
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  FeatureStateSnapshot,
  PackageInfo,
} from '../../core/feature.js';
import type { Context } from '../../core/context.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { StepStart, StepFinish } from '../../core/hooks-decorator.js';
import type { StepStartContext, StepFinishDecisionContext } from '../../core/lifecycle.js';
import { Decision } from '../../core/lifecycle.js';
import type { DecisionResult } from '../../core/lifecycle.js';
import type { Tool } from '../../core/types.js';
import { TodoToolFactory } from './tools.js';
import type { TodoTask, TodoTaskUpdate, TodoTaskSummary, TaskStatus, TodoFeatureConfig } from './types.js';

// ESM 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * TodoFeature 实现
 *
 * 提供任务管理和智能提醒功能
 * 使用反向钩子自动处理提醒逻辑，无需在 Agent 中重写钩子方法
 */
export class TodoFeature implements AgentFeature {
  readonly name = 'todo';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '维护任务清单，并在合适的循环时机自动提醒模型更新 todo 状态。';

  private tasks = new Map<string, TodoTask>();
  private counter = 0;
  private config: Required<Omit<TodoFeatureConfig, 'reminderTemplate' | 'reminderThresholdWithTasks' | 'reminderThresholdWithoutTasks'>> & {
    reminderTemplate?: string;
    reminderThresholdWithTasks?: number;
    reminderThresholdWithoutTasks?: number;
  };

  // Reminder 相关状态
  private reminderContent = '';

  // 连续未使用 todo 工具的轮次计数器
  private consecutiveNoTodoTurns = 0;
  // 上一轮是否已注入 reminder（防止重复注入）
  private reminderInjected = false;

  // 工具工厂实例
  private toolFactory?: TodoToolFactory;

  private _packageInfo: PackageInfo | null = null;

  constructor(config: TodoFeatureConfig = {}) {
    this.config = {
      reminderThresholdWithTasks: config.reminderThresholdWithTasks ?? 3,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks ?? 6,
      reminderTemplate: config.reminderTemplate,
    };
    this.reminderContent = this.getDefaultReminder();

    // 初始化工具工厂
    this.toolFactory = new TodoToolFactory({
      getTask: (taskId) => this.getTask(taskId),
      createTask: (subject, description, activeForm, options) => this.createTask(subject, description, activeForm, options),
      listTasks: (filter) => this.listTasks(filter),
      updateTask: (taskId, updates) => this.updateTask(taskId, updates),
      clearTasks: () => this.clearTasks(),
      getTasksCount: () => this.tasks.size,
    });
  }

  // ========== AgentFeature 接口实现 ==========

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
      'task-create',
      'task-list',
      'task-get',
      'task-update',
      'task-clear',
    ];
  }

  getTools(): Tool[] {
    return this.toolFactory?.getAllTools() || [];
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    console.log(`[TodoFeature] Initialized with reminderThresholdWithTasks=${this.config.reminderThresholdWithTasks}, reminderThresholdWithoutTasks=${this.config.reminderThresholdWithoutTasks}`);

    // 如果配置了模板文件，异步加载
    const templatePath = this.config.reminderTemplate;
    if (templatePath) {
      try {
        this.reminderContent = await readFile(templatePath, 'utf-8');
        console.log('[TodoFeature] Loaded reminder template from: ' + templatePath);
      } catch (e) {
        console.log('[TodoFeature] Failed to load template, using default reminder');
        // 保持默认 reminder
      }
    }
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    this.clearTasks();
  }

  captureState(): FeatureStateSnapshot {
    return {
      tasks: Array.from(this.tasks.values()),
      counter: this.counter,
      reminderContent: this.reminderContent,
      consecutiveNoTodoTurns: this.consecutiveNoTodoTurns,
      reminderInjected: this.reminderInjected,
    };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as {
      tasks?: TodoTask[];
      counter?: number;
      reminderContent?: string;
      consecutiveNoTodoTurns?: number;
      reminderInjected?: boolean;
    };

    this.tasks = new Map((state.tasks ?? []).map(task => [task.id, task]));
    this.counter = typeof state.counter === 'number' ? state.counter : 0;
    this.reminderContent = typeof state.reminderContent === 'string'
      ? state.reminderContent
      : this.getDefaultReminder();
    this.consecutiveNoTodoTurns = typeof state.consecutiveNoTodoTurns === 'number'
      ? state.consecutiveNoTodoTurns
      : 0;
    this.reminderInjected = Boolean(state.reminderInjected);
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'StepStart' && methodName === 'checkAndInjectReminder') {
      return '在每轮开始时检查提醒阈值；连续多轮未使用 todo 工具时注入系统提醒。';
    }
    if (lifecycle === 'StepFinish' && methodName === 'recordToolUsage') {
      return '在每轮结束后统计是否使用了 todo 工具，用于更新下轮提醒计数。';
    }
    return undefined;
  }

  // ========== 反向钩子（装饰器）==========

  /**
   * Step 开始时检查是否需要注入 reminder
   *
   * 触发时机：每轮 ReAct 迭代开始时
   * 处理逻辑：
   * 1. 检查连续未使用 todo 工具的轮次
   * 2. 达到阈值时注入 reminder 系统消息
   * 3. 防止重复注入
   */
  @StepStart
  async checkAndInjectReminder(ctx: StepStartContext): Promise<void> {
    const threshold = this.getCurrentThreshold();
    console.log(`[TodoFeature] callIndex=${ctx.callIndex}, counter=${this.consecutiveNoTodoTurns}, threshold=${threshold}, injected=${this.reminderInjected}`);

    // 检查是否需要注入 reminder
    if (this.consecutiveNoTodoTurns >= threshold && !this.reminderInjected) {
      console.log('[TodoFeature] Threshold reached, injecting reminder');
      ctx.context.add({ role: 'system', content: this.reminderContent });
      this.reminderInjected = true;
    }
  }

  /**
   * Step 结束时记录是否使用了 todo 工具
   *
   * 触发时机：每轮 ReAct 迭代结束时
   * 处理逻辑：
   * 1. 检查本轮是否使用了 todo 工具
   * 2. 使用了则重置计数器，未使用则计数器+1
   * 3. 返回 Continue 使用默认行为
   */
  @StepFinish
  async recordToolUsage(ctx: StepFinishDecisionContext): Promise<DecisionResult> {
    const toolCalls = ctx.llmResponse.toolCalls ?? [];
    const usedTodoTool = toolCalls.some((call: { name: string }) => this.isTodoTool(call.name));

    if (usedTodoTool) {
      // 使用了 todo 工具，重置计数器
      this.consecutiveNoTodoTurns = 0;
      this.reminderInjected = false;
      console.log(`[TodoFeature] Todo tool used, reset counter`);
    } else {
      // 未使用 todo 工具，计数器加 1
      this.consecutiveNoTodoTurns++;
      const threshold = this.getCurrentThreshold();
      console.log(`[TodoFeature] No todo tool, counter=${this.consecutiveNoTodoTurns}/${threshold}`);
    }

    // 返回 Continue 使用默认行为
    return Decision.Continue;
  }

  // ========== 公开 API ==========

  /**
   * 设置 reminder 内容
   */
  setReminderContent(content: string): void {
    this.reminderContent = content;
  }

  /**
   * 获取当前的提醒阈值（根据任务状态动态调整）
   */
  private getCurrentThreshold(): number {
    // 检查是否有待执行的任务（pending 或 in_progress）
    const hasActiveTasks = Array.from(this.tasks.values()).some(
      t => t.status === 'pending' || t.status === 'in_progress'
    );
    return hasActiveTasks
      ? this.config.reminderThresholdWithTasks!
      : this.config.reminderThresholdWithoutTasks!;
  }

  /**
   * 创建任务
   */
  createTask(
    subject: string,
    description: string,
    activeForm: string,
    options?: { owner?: string; metadata?: Record<string, unknown> }
  ): TodoTask {
    this.counter++;
    const task: TodoTask = {
      id: String(this.counter),
      subject,
      description,
      activeForm,
      status: 'pending',
      blocks: [],
      blockedBy: [],
      owner: options?.owner,
      metadata: options?.metadata,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    console.log(`[TodoFeature] Created task ${task.id}: ${subject} (total tasks: ${this.tasks.size})`);
    return task;
  }

  /**
   * 获取任务详情
   */
  getTask(taskId: string): TodoTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 列出所有任务摘要
   */
  listTasks(filter?: { status?: TaskStatus }): TodoTaskSummary[] {
    let tasks = Array.from(this.tasks.values());
    if (filter?.status) {
      tasks = tasks.filter(t => t.status === filter.status);
    }
    return tasks.map(task => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      owner: task.owner,
      blockedBy: task.blockedBy,
    }));
  }

  /**
   * 更新任务
   */
  updateTask(taskId: string, updates: TodoTaskUpdate): TodoTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    if (updates.addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...updates.addBlocks])];
    }
    if (updates.addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...updates.addBlockedBy])];
    }
    Object.assign(task, updates);
    task.updatedAt = Date.now();

    if (task.status === 'deleted') {
      this.tasks.delete(taskId);
    }
    return task;
  }

  /**
   * 清空所有任务
   */
  clearTasks(): void {
    this.tasks.clear();
    this.counter = 0;
  }

  // ========== 私有方法 ==========

  /** 判断是否是 todo 工具 */
  private isTodoTool(name: string): boolean {
    return name === 'task_create' || name === 'task_list' ||
      name === 'task_get' || name === 'task_update' || name === 'task_clear';
  }

  /** 获取默认 reminder 内容 */
  private getDefaultReminder(): string {
    return '最近没有使用任务工具。如果你正在处理需要跟踪进度的任务，考虑使用 `task_create` 添加新任务，使用 `task_update`更新任务状态（开始时设置为 in_progress，完成时设置为 completed）。如果任务列表已过时，也可以考虑清理。仅在与当前工作相关时使用这些工具。这只是温和的提醒——如果不适用请忽略。务必注意：绝不要向用户提及此提醒。';
  }
}

// 重新导出类型
export type { TodoTask, TodoTaskUpdate, TodoTaskSummary, TaskStatus, TodoFeatureConfig };
