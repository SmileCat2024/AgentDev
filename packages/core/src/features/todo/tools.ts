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
    options?: { deliver?: string; metadata?: Record<string, unknown> }
  ) => TodoTask;
  private listTasksFn: (filter?: { status?: TaskStatus }) => TodoTaskSummary[];
  private updateTaskFn: (taskId: string, updates: TodoTaskUpdate) => TodoTask | undefined;
  private clearTasksFn: () => number;

  constructor(options: {
    getTask: (taskId: string) => TodoTask | undefined;
    createTask: (
      subject: string,
      description: string,
      options?: { deliver?: string; metadata?: Record<string, unknown> }
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
      description: `创建结构化任务列表，跟踪当前会话的工作进度。适用于需要 3 个以上独立步骤、或需要仔细规划的复杂任务。

任务字段：
- subject: 简短可执行的祈使句标题（如 "修复认证漏洞"）
- description: 任务定义（可选）：要做什么、怎么验收，写给之后翻开这条任务的人；简单任务可不填
- deliver: 交付物（可选）：完成时留下什么产物证明"做完了"，一句短语，如「src/auth.ts」「61 项测试通过」。description 说要做什么，deliver 只说留下了什么；调查沟通类无可指认产物时留空

创建后任务为 pending，经 task_update 流转：in_progress → completed，或 deleted（取消并保留记录）。`,
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '简短的任务标题，使用祈使句形式（如 "运行测试"）' },
          description: { type: 'string', description: '任务定义：要做什么、怎么验收，写给之后翻开这条任务的人' },
          deliver: { type: 'string', description: '交付物：一句短语，如 "src/auth.ts"、"test/auth.test.js 全过"。只写结果产物，不写过程、不重复 description；无可指认产物时留空' },
        },
        required: ['subject'],
      },
      render: { call: 'task-create', result: 'task-create' },
      execute: ({ subject, description = '', deliver }: { subject?: unknown; description?: unknown; deliver?: unknown }) => {
        const deliverText = deliver === undefined || deliver === null ? undefined : String(deliver);
        const task = self.createTaskFn(String(subject), String(description), deliverText ? { deliver: deliverText } : undefined);
        // 模型只看极简确认；前端通过 display 看到完整信息
        return Promise.resolve(withDisplay(
          JSON.stringify({ ok: true, taskId: task.id, status: task.status }),
          {
            task: {
              id: task.id,
              subject: task.subject,
              description: task.description || '',
              deliver: task.deliver || '',
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
      description: `列出任务摘要（id、subject、deliver、status）。可按状态筛选，默认全部。`,
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
      execute: ({ status = 'all' }: { status?: TaskStatus | 'all' }) => {
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
      description: `更新任务的状态或内容。

状态工作流：pending → in_progress → completed；deleted 为取消并保留记录。标记 completed 时用 deliver 补上结果产物（一句短语），细节留在你的回复里。

并发约束：同一时刻只允许一个任务处于 in_progress；开始新任务前，先完成、取消当前进行中任务，或将其调整回 pending。

可更新字段（仅传需要更新的）：subject 祈使句标题；description 任务定义：要做什么、怎么验收；deliver 交付物一句短语。`,
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
          description: { type: 'string', description: '新的任务定义：要做什么、怎么验收' },
          deliver: { type: 'string', description: '交付物：一句短语，如 "src/auth.ts"、"61 项测试通过"。只写结果产物，不写过程、不重复 description' },
        },
        required: ['taskId'],
      },
      render: { call: 'task-update', result: 'task-update' },
      execute: (rawArgs: Record<string, unknown>) => {
        const { taskId, ...rest } = rawArgs as unknown as { taskId: string } & TodoTaskUpdate;
        // 单 in_progress 硬约束：目标从其他状态转入 in_progress 时，
        // 若已有另一任务处于 in_progress，拒绝并指明阻塞项。
        // 目标任务自身已是 in_progress 的重复设置（幂等）不受影响。
        if (rest.status === 'in_progress') {
          const target = self.getTaskFn(taskId);
          if (target && target.status !== 'in_progress') {
            const blocker = self.listTasksFn({ status: 'in_progress' }).find(t => t.id !== taskId);
            if (blocker) {
              return Promise.resolve({
                ok: false,
                error: `同一时刻只能有一个 in_progress 任务：#${blocker.id}「${blocker.subject}」正在进行中。请先将其标记为 completed（如已交付）、deleted（如不再适用），或调整回 pending，再开始任务 ${taskId}。`,
              });
            }
          }
        }
        const task = self.updateTaskFn(taskId, rest);
        if (!task) {
          return Promise.resolve({ ok: false, error: `任务 ${taskId} 不存在` });
        }
        return Promise.resolve(withDisplay(
          JSON.stringify({ ok: true, taskId: task.id, status: task.status }),
          {
            id: task.id,
            subject: task.subject,
            deliver: task.deliver || '',
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
      description: `取消所有未完成任务并保留历史：pending/in_progress 转为 deleted，completed 保留。`,
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
