/**
 * Todo Feature 工具定义
 *
 * 提供 4 个任务管理工具：task_create, task_list, task_update, task_clear
 *
 * 设计要点：
 * - execute 返回 withDisplay(精简文本, 丰富 display 数据)
 * - 模型只看到精简确认（如 { ok, taskId, status }）
 * - 前端通过 display 数据渲染完整卡片（如任务列表）
 * - 真正的完整任务列表在 StepFinish 时注入一次，而非每次 create 重复
 */

import type { Tool } from '../../core/types.js';
import { createTool } from '../../core/tool.js';
import { withDisplay } from '../../core/tool-result-display.js';
import type { TodoTask, TodoTaskUpdate, TodoTaskSummary, TaskStatus } from './types.js';

/**
 * Todo 工具工厂类
 * 用于创建 Todo 工具，需要传入 Feature 实例来访问任务数据
 */
export class TodoToolFactory {
  private getTaskFn: (taskId: string) => TodoTask | undefined;
  private createTaskFn: (
    subject: string,
    description: string,
    options?: { metadata?: Record<string, unknown> }
  ) => TodoTask;
  private listTasksFn: (filter?: { status?: TaskStatus }) => TodoTaskSummary[];
  private updateTaskFn: (taskId: string, updates: TodoTaskUpdate) => TodoTask | undefined;
  private clearTasksFn: () => number;

  constructor(options: {
    getTask: (taskId: string) => TodoTask | undefined;
    createTask: (
      subject: string,
      description: string,
      options?: { metadata?: Record<string, unknown> }
    ) => TodoTask;
    listTasks: (filter?: { status?: TaskStatus }) => TodoTaskSummary[];
    updateTask: (taskId: string, updates: TodoTaskUpdate) => TodoTask | undefined;
    clearTasks: () => number;
  }) {
    this.getTaskFn = options.getTask;
    this.createTaskFn = options.createTask;
    this.listTasksFn = options.listTasks;
    this.updateTaskFn = options.updateTask;
    this.clearTasksFn = options.clearTasks;
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
- description: 详细描述，包括上下文和验收标准（可选）

重要说明：
- subject 应该是祈使句形式（"执行任务"）
- description 是可选的，简单任务不需要填写
- 创建后任务状态为 pending，可以通过 task_update 更新为 in_progress、completed 或 deleted（取消并保留记录）`,
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '简短的任务标题，使用祈使句形式（如 "运行测试"）' },
          description: { type: 'string', description: '详细的任务描述，包括上下文、具体步骤和验收标准' },
        },
        required: ['subject'],
      },
      render: { call: 'task-create', result: 'task-create' },
      execute: ({ subject, description = '' }) => {
        const task = self.createTaskFn(subject, description);
        // 模型只看极简确认；前端通过 display 看到完整信息
        return Promise.resolve(withDisplay(
          JSON.stringify({ ok: true, taskId: task.id, status: task.status }),
          {
            task: {
              id: task.id,
              subject: task.subject,
              description: task.description || '',
              status: task.status,
            },
            allTasks: self.listTasksFn(),
            message: `任务已创建，ID: ${task.id}`,
          },
        ));
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
- 了解整体进度

返回信息：
- id: 任务标识符
- subject: 简短描述
- status: 任务状态（pending/in_progress/completed/deleted）`,
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'deleted', 'all'],
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
          cancelled: tasks.filter(t => t.status === 'deleted').length,
        };
        return Promise.resolve(withDisplay(
          JSON.stringify({ tasks }),
          { tasks, summary },
        ));
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
3. 取消任务并保留记录：将 status 设置为 "deleted"

任务字段：
- subject: 简短可执行的标题，使用祈使句形式（如 "执行任务"）
- description: 详细描述，包括上下文和验收标准`,
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
        },
        required: ['taskId'],
      },
      render: { call: 'task-update', result: 'task-update' },
      execute: ({ taskId, ...updates }) => {
        const task = self.updateTaskFn(taskId, updates);
        if (!task) {
          return Promise.resolve({ ok: false, error: `任务 ${taskId} 不存在` });
        }
        return Promise.resolve(withDisplay(
          JSON.stringify({ ok: true, taskId: task.id, status: task.status }),
          {
            id: task.id,
            subject: task.subject,
            status: task.status,
            message: `任务 ${taskId} 已更新`,
          },
        ));
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
      description: `取消任务列表中的所有未完成任务，并保留历史记录。

注意：此操作不会移除历史；pending/in_progress 会变为 deleted，completed 会保留。`,
      parameters: {
        type: 'object',
        properties: {},
      },
      render: { call: 'task-clear', result: 'task-clear' },
      execute: () => {
        const cancelledCount = self.clearTasksFn();
        return Promise.resolve(withDisplay(
          JSON.stringify({ ok: true, cancelledCount }),
          { message: `已取消 ${cancelledCount} 个未完成任务` },
        ));
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
      this.createUpdateTool(),
      this.createClearTool(),
    ];
  }
}
