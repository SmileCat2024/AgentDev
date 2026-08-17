/**
 * Todo Feature - 任务列表管理功能模块
 *
 * 提供任务创建、查询、更新等能力，用于跟踪复杂任务的进度
 * 内置智能提醒功能，自动跟踪工具使用并在合适时机注入提醒
 *
 * 重构说明：
 * - 使用 static hooks 静态声明反向钩子实现提醒逻辑
 * - 不再需要在 Agent 中重写 onStepStart/onStepFinished
 * - 每个发生 Todo 写操作的 Step 结束后，自动注入一次最新完整任务列表
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
import type { HookDeclarations } from '../../core/hook-declarations.js';
import { CoreLifecycle } from '../../core/lifecycle.js';
import type { Context } from '../../core/context.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import type { StepStartContext, StepFinishDecisionContext, CallStartContext } from '../../core/lifecycle.js';
import { Decision } from '../../core/lifecycle.js';
import type { DecisionResult } from '../../core/lifecycle.js';
import type { Tool } from '../../core/types.js';
import type { TodoPlanSnapshot } from '../../core/types.js';
import { DebugHub } from '../../core/debug-hub.js';
import { TodoToolFactory } from './tools.js';
import type { TodoTask, TodoTaskUpdate, TodoTaskSummary, TaskStatus, TodoFeatureConfig } from './types.js';

// ESM 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** StepFinish 注入的任务列表体积上限 */
const MAX_INJECT_TASKS = 20;
const MAX_SUBJECT_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * TodoFeature 实现
 *
 * 提供任务管理和智能提醒功能
 * 使用反向钩子自动处理提醒逻辑，无需在 Agent 中重写钩子方法
 */
export class TodoFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    checkAndInjectReminder: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' as const },
    onCallStart: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
    recordToolUsage: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
  };
  readonly name = 'todo';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '维护任务清单，并在合适的循环时机自动提醒模型更新 todo 状态。';

  private tasks = new Map<string, TodoTask>();
  private counter = 0;
  private debugAgentId = '';
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
      createTask: (subject, description, options) => this.createTask(subject, description, options),
      listTasks: (filter) => this.listTasks(filter),
      updateTask: (taskId, updates) => this.updateTask(taskId, updates),
      clearTasks: () => this.clearTasks(),
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
    this.pushDebugSnapshot();
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

    // 白名单重建：仅保留新 schema 字段，丢弃旧 session 中可能存在的
    // activeForm/owner/blocks/blockedBy 等已删除字段
    this.tasks = new Map((state.tasks ?? []).map(task => [
      task.id,
      {
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        metadata: task.metadata,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    ]));
    this.counter = typeof state.counter === 'number' ? state.counter : 0;
    this.reminderContent = typeof state.reminderContent === 'string'
      ? state.reminderContent
      : this.getDefaultReminder();
    this.consecutiveNoTodoTurns = typeof state.consecutiveNoTodoTurns === 'number'
      ? state.consecutiveNoTodoTurns
      : 0;
    this.reminderInjected = Boolean(state.reminderInjected);
    this.pushDebugSnapshot();
  }

  pushDebugSnapshot(agentId?: string): void {
    if (agentId) {
      this.debugAgentId = agentId;
    }
    const hub = DebugHub.getInstance();
    const targetAgentId = agentId || this.debugAgentId || hub.getCurrentAgentId();
    if (!targetAgentId || !hub.isConnected()) return;
    hub.updateTodoPlan(targetAgentId, this.getPlanSnapshot());
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'StepStart' && methodName === 'checkAndInjectReminder') {
      return '在每轮开始时检查提醒阈值；连续多轮未使用 todo 工具时注入系统提醒（含当前/下一任务状态）。';
    }
    if (lifecycle === 'StepFinish' && methodName === 'recordToolUsage') {
      return '统计 todo 工具使用并更新计数；若本轮有写操作，向 Context 注入一次最新完整任务列表。';
    }
    return undefined;
  }

  // ========== 反向钩子（static hooks 声明）==========

  /**
   * Step 开始时检查是否需要注入 reminder
   *
   * 触发时机：每轮 ReAct 迭代开始时
   * 处理逻辑：
   * 1. 检查连续未使用 todo 工具的轮次
   * 2. 达到阈值时注入 reminder 系统消息（包含当前/下一任务状态）
   * 3. 防止重复注入
   */
  async checkAndInjectReminder(ctx: StepStartContext): Promise<void> {
    const threshold = this.getCurrentThreshold();
    console.log(`[TodoFeature] callIndex=${ctx.callIndex}, counter=${this.consecutiveNoTodoTurns}, threshold=${threshold}, injected=${this.reminderInjected}`);

    // 检查是否需要注入 reminder
    if (this.consecutiveNoTodoTurns >= threshold && !this.reminderInjected) {
      console.log('[TodoFeature] Threshold reached, injecting reminder');
      ctx.context.add({ role: 'system', content: this.buildDynamicReminder() });
      this.reminderInjected = true;
    }
  }

  /**
   * Call 开始时注入简短任务状态
   *
   * 触发时机：每次用户发送新消息、Agent 开始处理时
   * 处理逻辑：
   * 1. 首次调用跳过（还没有任务）
   * 2. 无待执行任务时跳过
   * 3. 有待执行任务时注入简短的"当前/下一项"状态
   * 4. 重置 no-todo 计数器（新一轮用户交互）
   */
  async onCallStart(ctx: CallStartContext): Promise<void> {
    // 首次调用不注入
    if (ctx.isFirstCall) return;

    // 检查是否有待执行任务
    const hasActiveTasks = Array.from(this.tasks.values()).some(
      t => t.status === 'pending' || t.status === 'in_progress'
    );
    if (!hasActiveTasks) return;

    // 注入简短任务状态
    ctx.context.add({ role: 'system', content: this.buildCallStartBrief() });

    // 重置计数器（新的用户消息代表新一轮交互）
    this.consecutiveNoTodoTurns = 0;
    this.reminderInjected = false;

    console.log('[TodoFeature] CallStart: injected brief task status, reset counter');
  }

  /**
   * Step 结束时记录是否使用了 todo 工具
   *
   * 触发时机：每轮 ReAct 迭代结束时（工具结果已写入 Context 后）
   * 处理逻辑：
   * 1. 检查本轮是否使用了 todo 工具
   * 2. 若有写操作（create/update/clear），向 Context 追加一次最新完整任务列表
   * 3. 使用了则重置计数器，未使用则计数器+1
   * 4. 返回 Continue 使用默认行为
   */
  async recordToolUsage(ctx: StepFinishDecisionContext): Promise<DecisionResult> {
    const toolCalls = ctx.llmResponse.toolCalls ?? [];
    const usedTodoTool = toolCalls.some((call: { name: string }) => this.isTodoTool(call.name));
    const wroteTodo = toolCalls.some((call: { name: string }) => this.isTodoWriteTool(call.name));

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

    // 若本轮有 Todo 写操作，注入一次最新完整任务列表
    if (wroteTodo) {
      const planContext = this.buildCurrentTaskPlanContext();
      ctx.context.addSystemMessage(
        planContext,
        ctx.callIndex,
        this.name,
        'todo-current-plan',
      );
      console.log('[TodoFeature] Injected current task plan after write operations');
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
    description: string = '',
    options?: { metadata?: Record<string, unknown> }
  ): TodoTask {
    this.counter++;
    const task: TodoTask = {
      id: String(this.counter),
      subject,
      description: description || undefined,
      status: 'pending',
      metadata: options?.metadata,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    console.log(`[TodoFeature] Created task ${task.id}: ${subject} (total tasks: ${this.tasks.size})`);
    this.pushDebugSnapshot();
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
    }));
  }

  /**
   * 更新任务
   *
   * 允许更新的字段：status, subject, description（模型工具可见）。
   * metadata 不在模型工具 schema 中，但内部代码（如 ControlledTodoFeature）
   * 需要通过它记录终态时间戳等生命周期数据。
   */
  updateTask(taskId: string, updates: TodoTaskUpdate & { metadata?: Record<string, unknown> }): TodoTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const allowedFields: string[] = ['status', 'subject', 'description', 'metadata'];
    for (const field of allowedFields) {
      if (updates[field as keyof typeof updates] !== undefined) {
        (task as unknown as Record<string, unknown>)[field] = updates[field as keyof typeof updates];
      }
    }
    task.updatedAt = Date.now();

    this.pushDebugSnapshot();
    return task;
  }

  /**
   * 清空所有未完成任务，返回被取消的任务数量
   */
  clearTasks(): number {
    const now = Date.now();
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        task.status = 'deleted';
        task.updatedAt = now;
        count++;
      }
    }
    this.pushDebugSnapshot();
    return count;
  }

  getPlanSnapshot(): TodoPlanSnapshot {
    const tasks = Array.from(this.tasks.values())
      .map(task => ({
        id: task.id,
        subject: task.subject,
        description: task.description || '',
        status: task.status,
        metadata: task.metadata && typeof task.metadata === 'object' ? { ...task.metadata } : undefined,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }))
      .sort((left, right) => left.createdAt - right.createdAt || Number(left.id) - Number(right.id));
    return {
      feature: 'todo',
      updatedAt: Date.now(),
      counter: this.counter,
      tasks,
      summary: {
        total: tasks.length,
        pending: tasks.filter(task => task.status === 'pending').length,
        inProgress: tasks.filter(task => task.status === 'in_progress').length,
        completed: tasks.filter(task => task.status === 'completed').length,
        cancelled: tasks.filter(task => task.status === 'deleted').length,
      },
    };
  }

  // ========== 私有方法 ==========

  /** 判断是否是 todo 工具（读或写） */
  private isTodoTool(name: string): boolean {
    return name === 'task_create' || name === 'task_list' ||
      name === 'task_update' || name === 'task_clear';
  }

  /** 判断是否是 todo 写工具（仅 task_create 触发完整列表注入） */
  private isTodoWriteTool(name: string): boolean {
    return name === 'task_create';
  }

  /** 截断文本到指定长度 */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '…';
  }

  /**
   * 构建 StepFinish 注入的最新完整任务列表文本
   * 仅包含 active tasks（pending + in_progress），按 createdAt 升序
   */
  private buildCurrentTaskPlanContext(): string {
    const activeTasks = Array.from(this.tasks.values())
      .filter(task => task.status === 'pending' || task.status === 'in_progress')
      .sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id));

    if (activeTasks.length === 0) {
      return '当前没有待执行任务。若当前工作仍需多步跟踪，可创建任务。不要向用户提及此内部提示。';
    }

    const visible = activeTasks.slice(0, MAX_INJECT_TASKS);
    const omitted = activeTasks.length - visible.length;

    const lines: string[] = ['[当前任务计划]'];
    for (const task of visible) {
      const subject = this.truncate(task.subject, MAX_SUBJECT_LENGTH);
      const desc = task.description ? this.truncate(task.description, MAX_DESCRIPTION_LENGTH) : '';
      lines.push(`- #${task.id} [${task.status}] ${subject}`);
      if (desc) {
        lines.push(`  ${desc}`);
      }
    }
    if (omitted > 0) {
      lines.push(`（其余 ${omitted} 项未展示；如需查看全部计划，请使用 task_list。）`);
    }
    lines.push('');
    lines.push('请以此列表作为当前任务计划继续推进；任务开始、完成、调整或取消时，使用 Todo 工具同步状态。');
    lines.push('不要向用户提及此内部提示。');

    return lines.join('\n');
  }

  /**
   * 构建动态 reminder 文本
   * 如果有 active tasks，包含"当前"和"下一项"信息
   * 否则回退到默认温和提醒
   */
  private buildDynamicReminder(): string {
    const activeTasks = Array.from(this.tasks.values())
      .filter(task => task.status === 'pending' || task.status === 'in_progress')
      .sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id));

    if (activeTasks.length === 0) {
      // 无待执行任务，使用自定义模板或默认提醒
      return this.reminderContent || this.getDefaultReminder();
    }

    const currentTask = activeTasks.find(t => t.status === 'in_progress');
    const nextTask = activeTasks.find(t => t.status === 'pending');

    const lines: string[] = ['[任务状态提醒]'];
    if (currentTask) {
      lines.push(`当前：#${currentTask.id} ${currentTask.subject}`);
    } else {
      lines.push('当前：无');
    }
    if (nextTask) {
      lines.push(`下一项：#${nextTask.id} ${nextTask.subject}`);
    } else {
      lines.push('下一项：无');
    }
    lines.push('');
    // 拼接自定义模板尾部或默认提醒文本
    const tail = this.reminderContent || this.getDefaultReminder();
    lines.push(tail);

    return lines.join('\n');
  }

  /** 获取默认 reminder 内容 */
  private getDefaultReminder(): string {
    return '最近没有更新任务状态。若该计划仍适用，请在开始、完成、调整或取消任务时使用 Todo 工具同步状态；若计划已不适用，可清理未完成任务。仅在与当前工作相关时使用这些工具。这只是温和的提醒——如果不适用请忽略。务必注意：绝不要向用户提及此提醒。';
  }

  /**
   * 构建 CallStart 简短任务状态
   * 仅包含"当前/下一项"两行，不附带催促语
   */
  private buildCallStartBrief(): string {
    const activeTasks = Array.from(this.tasks.values())
      .filter(task => task.status === 'pending' || task.status === 'in_progress')
      .sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id));

    const currentTask = activeTasks.find(t => t.status === 'in_progress');
    const nextTask = activeTasks.find(t => t.status === 'pending');

    const lines: string[] = ['[任务状态]'];
    if (currentTask) {
      lines.push(`当前：#${currentTask.id} ${currentTask.subject}`);
    } else {
      lines.push('当前：无');
    }
    if (nextTask) {
      lines.push(`下一项：#${nextTask.id} ${nextTask.subject}`);
    } else {
      lines.push('下一项：无');
    }
    lines.push('');
    lines.push('请根据当前任务计划继续推进。不要向用户提及此内部提示。');

    return lines.join('\n');
  }
}

// 重新导出类型
export type { TodoTask, TodoTaskUpdate, TodoTaskSummary, TaskStatus, TodoFeatureConfig };
