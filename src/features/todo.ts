/**
 * Todo Feature - 任务列表管理功能模块
 *
 * 提供任务创建、查询、更新等能力，用于跟踪复杂任务的进度
 * 内置智能提醒功能，自动跟踪工具使用并在合适时机注入提醒
 */

import { createTool } from '../core/tool.js';
import type { Tool } from '../core/types.js';
import type { ToolCall } from '../core/types.js';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  ReActLoopHooks,
} from '../core/feature.js';
import type { ContextFeature } from '../core/context-types.js';
import { readFile } from 'fs/promises';
import type { Context } from '../core/context.js';

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/**
 * 任务数据结构
 */
export interface TodoTask {
  /** 任务 ID */
  id: string;
  /** 任务标题（祈使句） */
  subject: string;
  /** 详细描述 */
  description: string;
  /** 进行时形式（用于进度显示） */
  activeForm: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 负责人（Agent ID） */
  owner?: string;
  /** 此任务阻塞的其他任务 ID */
  blocks: string[];
  /** 阻塞此任务的其他任务 ID */
  blockedBy: string[];
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * 任务更新参数
 */
export interface TodoTaskUpdate {
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
}

/**
 * 任务列表摘要
 */
export interface TodoTaskSummary {
  id: string;
  subject: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];
}

/**
 * TodoFeature 配置
 */
export interface TodoFeatureConfig {
  /** Reminder 模板文件路径 */
  reminderTemplate?: string;
  /** 有待执行任务时的提醒间隔（默认：3 轮） */
  reminderThresholdWithTasks?: number;
  /** 无待执行任务时的提醒间隔（默认：6 轮） */
  reminderThresholdWithoutTasks?: number;
}

/**
 * TodoFeature 实现
 *
 * 提供任务管理和智能提醒功能
 */
export class TodoFeature implements AgentFeature {
  readonly name = 'todo';
  readonly dependencies = ['context'];

  private tasks = new Map<string, TodoTask>();
  private counter = 0;
  private config: Required<Omit<TodoFeatureConfig, 'reminderTemplate' | 'reminderThresholdWithTasks' | 'reminderThresholdWithoutTasks'>> & {
    reminderTemplate?: string;
    reminderThresholdWithTasks?: number;
    reminderThresholdWithoutTasks?: number;
  };

  // Reminder 相关状态
  private context?: ContextFeature;
  private reminderContent = '';

  // 连续未使用 todo 工具的轮次计数器
  private consecutiveNoTodoTurns = 0;
  // 上一轮是否已注入 reminder（防止重复注入）
  private reminderInjected = false;

  constructor(config: TodoFeatureConfig = {}) {
    this.config = {
      reminderThresholdWithTasks: config.reminderThresholdWithTasks ?? 3,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks ?? 6,
    };
    this.reminderContent = this.getDefaultReminder();
  }

  // ========== AgentFeature 接口实现 ==========

  getTools(): Tool[] {
    return [
      this.createCreateTool(),
      this.createListTool(),
      this.createGetTool(),
      this.createUpdateTool(),
      this.createClearTool(),
    ];
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.context = ctx.getContextFeature();
    if (!this.context) {
      throw new Error('TodoFeature requires ContextFeature. Register ContextFeature first: agent.use(new ContextFeature())');
    }

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

  // ========== 公开 API（供 Agent 使用） ==========

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
   * 记录本轮是否使用了 todo 工具
   * 在 Agent 的 onTurnFinished 钩子中调用
   */
  recordToolUsage(toolCalls: ToolCall[]): void {
    const usedTodoTool = toolCalls.some(call => this.isTodoTool(call.name));

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
  }

  /**
   * 在每轮开始时检查是否需要注入 reminder
   * 在 Agent 的 onTurnStart 钩子中调用
   */
  checkAndInjectReminder(ctx: {
    context: Context;
    callTurn: number;
  }): void {
    if (!this.context) return;

    const threshold = this.getCurrentThreshold();
    console.log(`[TodoFeature] callTurn=${ctx.callTurn}, counter=${this.consecutiveNoTodoTurns}, threshold=${threshold}, injected=${this.reminderInjected}`);

    // 检查是否需要注入 reminder
    if (this.consecutiveNoTodoTurns >= threshold && !this.reminderInjected) {
      console.log('[TodoFeature] Threshold reached, injecting reminder');
      ctx.context.add({ role: 'system', content: this.reminderContent });
      this.reminderInjected = true;
    }
  }

  // ========== 公开 API（供 Agent 使用） ==========

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

  // ========== 工具创建方法 ==========

  private createCreateTool(): Tool {
    const self = this;
    return createTool({
      name: 'task_create',
      description: `创建一个结构化的任务列表，用于跟踪当前会话的工作进度。

使用时机：
- 复杂的多步骤任务（需要 3 个或以上独立步骤）
- 非平凡且复杂的任务（需要仔细规划）
- 用户明确要求创建任务列表
- 收到新指令时捕获任务

任务字段：
- subject: 简短可执行的标题，使用祈使句形式（如 "修复认证漏洞"）
- description: 详细描述，包括上下文和验收标准
- activeForm: 进行时形式，显示在进度加载中（如 "正在修复认证漏洞"）

重要说明：
- 必须提供 activeForm，subject 应该是祈使句形式（"执行任务"），activeForm 应该是进行时形式（"正在执行任务"）
- 创建后任务状态为 pending，可以通过 task_update 更新为 in_progress 或 completed`,
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '简短的任务标题，使用祈使句形式（如 "运行测试"）' },
          description: { type: 'string', description: '详细的任务描述，包括上下文、具体步骤和验收标准' },
          activeForm: { type: 'string', description: '进行时形式，用于显示任务进行中的状态（如 "正在运行测试"）' },
          metadata: { type: 'object', description: '可选的元数据信息', additionalProperties: true },
        },
        required: ['subject', 'description', 'activeForm'],
      },
      render: { call: 'task-create', result: 'task-create' },
      execute: ({ subject, description, activeForm, metadata }) => {
        const task = self.createTask(subject, description, activeForm, { metadata });
        return Promise.resolve({
          task: {
            id: task.id,
            subject: task.subject,
            description: task.description,
            activeForm: task.activeForm,
            status: task.status,
            blockedBy: task.blockedBy,
          },
          allTasks: self.listTasks(),
          message: `任务已创建，ID: ${task.id}`,
        });
      },
    });
  }

  private createListTool(): Tool {
    const self = this;
    return createTool({
      name: 'task_list',
      description: `列出任务列表中的所有任务摘要。

使用时机：
- 查看当前所有任务的状态
- 找到下一个可执行的任务（blockedBy 为空的任务）
- 了解整体进度

返回信息：
- id: 任务标识符
- subject: 简短描述
- status: 任务状态（pending/in_progress/completed）
- owner: 负责人（如果已分配）
- blockedBy: 阻塞此任务的其他任务 ID 列表`,
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'all'],
            description: '按状态筛选任务，默认显示所有任务',
            default: 'all',
          },
        },
      },
      render: { call: 'task-list', result: 'task-list' },
      execute: ({ status = 'all' }) => {
        const tasks = self.listTasks(status === 'all' ? undefined : { status });
        const summary = {
          total: tasks.length,
          pending: tasks.filter(t => t.status === 'pending').length,
          inProgress: tasks.filter(t => t.status === 'in_progress').length,
          completed: tasks.filter(t => t.status === 'completed').length,
        };
        return Promise.resolve({ tasks, summary });
      },
    });
  }

  private createGetTool(): Tool {
    const self = this;
    return createTool({
      name: 'task_get',
      description: `获取指定任务的详细信息。

使用时机：
- 开始工作前了解任务的完整描述和上下文
- 查看任务的依赖关系（blocks 和 blockedBy）
- 确认任务是否可以开始执行（检查 blockedBy 是否为空）`,
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 ID' },
        },
        required: ['taskId'],
      },
      render: { call: 'task-get', result: 'task-get' },
      execute: ({ taskId }) => {
        const task = self.getTask(taskId);
        if (!task) {
          return Promise.resolve({ error: `任务不存在: ${taskId}` });
        }
        return Promise.resolve({
          id: task.id,
          subject: task.subject,
          description: task.description,
          activeForm: task.activeForm,
          status: task.status,
          owner: task.owner,
          blocks: task.blocks,
          blockedBy: task.blockedBy,
        });
      },
    });
  }

  private createUpdateTool(): Tool {
    const self = this;
    return createTool({
      name: 'task_update',
      description: `更新任务的状态或详细信息。

状态工作流：pending → in_progress → completed

主要用途：
1. 标记任务进行中：将 status 设置为 "in_progress"
2. 标记任务完成：将 status 设置为 "completed"
3. 删除任务：将 status 设置为 "deleted"

依赖关系管理：
- addBlocks: 添加此任务阻塞的其他任务 ID
- addBlockedBy: 添加阻塞此任务的其他任务 ID`,
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '要更新的任务 ID' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'deleted'],
            description: '任务状态',
          },
          subject: { type: 'string', description: '新的任务标题' },
          description: { type: 'string', description: '新的任务描述' },
          activeForm: { type: 'string', description: '新的进行时形式' },
          owner: { type: 'string', description: '任务负责人' },
          addBlocks: { type: 'array', items: { type: 'string' }, description: '添加此任务阻塞的其他任务 ID' },
          addBlockedBy: { type: 'array', items: { type: 'string' }, description: '添加阻塞此任务的其他任务 ID' },
          metadata: { type: 'object', description: '元数据', additionalProperties: true },
        },
        required: ['taskId'],
      },
      render: { call: 'task-update', result: 'task-update' },
      execute: ({ taskId, ...updates }) => {
        const task = self.updateTask(taskId, updates);
        if (!task) {
          return Promise.resolve({ error: `任务不存在: ${taskId}` });
        }
        return Promise.resolve({
          id: task.id,
          subject: task.subject,
          status: task.status,
          owner: task.owner,
          blockedBy: task.blockedBy,
          message: `任务 ${taskId} 已更新`,
        });
      },
    });
  }

  private createClearTool(): Tool {
    const self = this;
    return createTool({
      name: 'task_clear',
      description: `清空任务列表中的所有任务。

注意：此操作不可逆，所有任务将被永久删除。`,
      parameters: {
        type: 'object',
        properties: {},
      },
      render: { call: 'task-clear', result: 'task-clear' },
      execute: () => {
        const count = self.tasks.size;
        self.clearTasks();
        return Promise.resolve({ message: `已清空 ${count} 个任务` });
      },
    });
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
