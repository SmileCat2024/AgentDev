/**
 * Todo Feature 工具定义
 *
 * 提供 5 个任务管理工具：task_create, task_list, task_get, task_update, task_clear
 */

import type { Tool } from '../../core/types.js';
import { createTool } from '../../core/tool.js';
import type { TodoTask, TodoTaskUpdate, TodoTaskSummary, TaskStatus } from './types.js';

/**
 * Todo 工具工厂类
 * 用于创建 Todo 工具，需要传入 Feature 实例来访问任务数据
 */
export class TodoToolFactory {
  /**
   * 获取任务列表的方法（由 Feature 提供）
   */
  private getTaskFn: (taskId: string) => TodoTask | undefined;

  /**
   * 创建任务的方法（由 Feature 提供）
   */
  private createTaskFn: (
    subject: string,
    description: string,
    activeForm: string,
    options?: { metadata?: Record<string, unknown> }
  ) => TodoTask;

  /**
   * 列出任务的方法（由 Feature 提供）
   */
  private listTasksFn: (filter?: { status?: TaskStatus }) => TodoTaskSummary[];

  /**
   * 更新任务的方法（由 Feature 提供）
   */
  private updateTaskFn: (taskId: string, updates: TodoTaskUpdate) => TodoTask | undefined;

  /**
   * 清空任务的方法（由 Feature 提供）
   */
  private clearTasksFn: () => void;

  /**
   * 获取任务数量的方法（由 Feature 提供）
   */
  private getTasksCountFn: () => number;

  constructor(options: {
    getTask: (taskId: string) => TodoTask | undefined;
    createTask: (
      subject: string,
      description: string,
      activeForm: string,
      options?: { metadata?: Record<string, unknown> }
    ) => TodoTask;
    listTasks: (filter?: { status?: TaskStatus }) => TodoTaskSummary[];
    updateTask: (taskId: string, updates: TodoTaskUpdate) => TodoTask | undefined;
    clearTasks: () => void;
    getTasksCount: () => number;
  }) {
    this.getTaskFn = options.getTask;
    this.createTaskFn = options.createTask;
    this.listTasksFn = options.listTasks;
    this.updateTaskFn = options.updateTask;
    this.clearTasksFn = options.clearTasks;
    this.getTasksCountFn = options.getTasksCount;
  }

  /**
   * 创建 task_create 工具
   */
  createCreateTool(): Tool {
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
        const task = self.createTaskFn(subject, description, activeForm, { metadata });
        return Promise.resolve({
          task: {
            id: task.id,
            subject: task.subject,
            description: task.description,
            activeForm: task.activeForm,
            status: task.status,
            blockedBy: task.blockedBy,
          },
          allTasks: self.listTasksFn(),
          message: `任务已创建，ID: ${task.id}`,
        });
      },
    });
  }

  /**
   * 创建 task_list 工具
   */
  createListTool(): Tool {
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
        const tasks = self.listTasksFn(status === 'all' ? undefined : { status });
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

  /**
   * 创建 task_get 工具
   */
  createGetTool(): Tool {
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
        const task = self.getTaskFn(taskId);
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

  /**
   * 创建 task_update 工具
   */
  createUpdateTool(): Tool {
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
        const task = self.updateTaskFn(taskId, updates);
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

  /**
   * 创建 task_clear 工具
   */
  createClearTool(): Tool {
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
        const count = self.getTasksCountFn();
        self.clearTasksFn();
        return Promise.resolve({ message: `已清空 ${count} 个任务` });
      },
    });
  }

  /**
   * 获取所有工具
   */
  getAllTools(): Tool[] {
    return [
      this.createCreateTool(),
      this.createListTool(),
      this.createGetTool(),
      this.createUpdateTool(),
      this.createClearTool(),
    ];
  }
}
