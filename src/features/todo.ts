/**
 * Todo Feature - 任务列表管理功能模块
 *
 * 提供任务创建、查询、更新等能力，用于跟踪复杂任务的进度
 *
 * @example
 * ```typescript
 * agent.use(new TodoFeature());
 *
 * // LLM 可以使用的工具：
 * // - task_create: 创建新任务
 * // - task_list: 列出所有任务
 * // - task_get: 获取任务详情
 * // - task_update: 更新任务状态
 * ```
 */

import { createTool } from '../core/tool.js';
import type { Tool } from '../core/types.js';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
} from '../core/feature.js';

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
 * 任务更新参数（包含临时的 addBlocks/addBlockedBy）
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
  /** 任务存储目录（可选，默认内存存储） */
  storageDir?: string;
}

/**
 * TodoFeature 实现
 */
export class TodoFeature implements AgentFeature {
  readonly name = 'todo';
  readonly dependencies: string[] = [];

  private tasks = new Map<string, TodoTask>();
  private counter = 0;
  private config?: TodoFeatureConfig;

  constructor(config?: TodoFeatureConfig) {
    this.config = config;
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

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    // 初始化逻辑（如从文件加载任务）
    // 当前版本仅使用内存存储
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 清理逻辑（如保存任务到文件）
    // 当前版本仅使用内存存储
  }

  // ========== 公开方法 ==========

  /**
   * 创建新任务
   */
  createTask(
    subject: string,
    description: string,
    activeForm: string,
    options?: {
      owner?: string;
      metadata?: Record<string, unknown>;
    }
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
  listTasks(): TodoTaskSummary[] {
    return Array.from(this.tasks.values()).map(task => ({
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
  updateTask(
    taskId: string,
    updates: TodoTaskUpdate
  ): TodoTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    // 处理 blocks/blockedBy 的添加
    if (updates.addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...updates.addBlocks])];
    }
    if (updates.addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...updates.addBlockedBy])];
    }

    // 更新其他字段
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
    if (updates.owner !== undefined) task.owner = updates.owner;
    if (updates.metadata !== undefined) task.metadata = updates.metadata;

    task.updatedAt = Date.now();

    // 如果状态是 deleted，从列表中移除
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

  /**
   * task_create - 创建新任务
   */
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
          subject: {
            type: 'string',
            description: '简短的任务标题，使用祈使句形式（如 "运行测试"）',
          },
          description: {
            type: 'string',
            description: '详细的任务描述，包括上下文、具体步骤和验收标准',
          },
          activeForm: {
            type: 'string',
            description: '进行时形式，用于显示任务进行中的状态（如 "正在运行测试"）',
          },
          metadata: {
            type: 'object',
            description: '可选的元数据信息',
            additionalProperties: true,
          },
        },
        required: ['subject', 'description', 'activeForm'],
      },
      render: { call: 'task-create', result: 'task-create' },
      execute: ({ subject, description, activeForm, metadata }) => {
        const task = self.createTask(subject, description, activeForm, { metadata });
        const allTasks = self.listTasks();

        return Promise.resolve({
          task: {
            id: task.id,
            subject: task.subject,
            description: task.description,
            activeForm: task.activeForm,
            status: task.status,
            blockedBy: task.blockedBy,
          },
          allTasks,
          message: `任务已创建，ID: ${task.id}`,
        });
      },
    });
  }

  /**
   * task_list - 列出所有任务
   */
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
- blockedBy: 阻塞此任务的其他任务 ID 列表

提示：
- 优先执行 ID 较小的任务
- 只有 blockedBy 为空且无 owner 的任务可以开始执行`,
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
        let tasks = self.listTasks();
        if (status !== 'all') {
          tasks = tasks.filter(t => t.status === status);
        }

        const pending = tasks.filter(t => t.status === 'pending').length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const completed = tasks.filter(t => t.status === 'completed').length;

        return Promise.resolve({
          tasks,
          summary: {
            total: tasks.length,
            pending,
            inProgress,
            completed,
          },
        });
      },
    });
  }

  /**
   * task_get - 获取任务详情
   */
  private createGetTool(): Tool {
    const self = this;
    return createTool({
      name: 'task_get',
      description: `获取指定任务的详细信息。

使用时机：
- 开始工作前了解任务的完整描述和上下文
- 查看任务的依赖关系（blocks 和 blockedBy）
- 确认任务是否可以开始执行（检查 blockedBy 是否为空）

返回完整任务详情：
- subject: 任务标题
- description: 详细描述
- status: 任务状态
- blocks: 此任务阻塞的其他任务列表
- blockedBy: 阻塞此任务的其他任务列表（必须为空才能开始执行）

提示：
- 获取任务后，确认 blockedBy 列表为空再开始工作
- 使用 TaskUpdate 更新任务状态为 in_progress`,
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: '任务 ID',
          },
        },
        required: ['taskId'],
      },
      render: { call: 'task-get', result: 'task-get' },
      execute: ({ taskId }) => {
        const task = self.getTask(taskId);
        if (!task) {
          return Promise.resolve({
            error: `任务不存在: ${taskId}`,
          });
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
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
      },
    });
  }

  /**
   * task_update - 更新任务
   */
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
- addBlockedBy: 添加阻塞此任务的其他任务 ID

其他可更新字段：
- subject: 任务标题
- description: 任务描述
- activeForm: 进行时形式
- owner: 负责人
- metadata: 元数据

重要说明：
- 完成任务时，务必标记为 completed
- 只有 blockedBy 为空的任务可以被开始执行
- 删除的任务将从列表中永久移除`,
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: '要更新的任务 ID',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'deleted'],
            description: '任务状态',
          },
          subject: {
            type: 'string',
            description: '新的任务标题',
          },
          description: {
            type: 'string',
            description: '新的任务描述',
          },
          activeForm: {
            type: 'string',
            description: '新的进行时形式',
          },
          owner: {
            type: 'string',
            description: '任务负责人',
          },
          addBlocks: {
            type: 'array',
            items: { type: 'string' },
            description: '添加此任务阻塞的其他任务 ID',
          },
          addBlockedBy: {
            type: 'array',
            items: { type: 'string' },
            description: '添加阻塞此任务的其他任务 ID',
          },
          metadata: {
            type: 'object',
            description: '元数据',
            additionalProperties: true,
          },
        },
        required: ['taskId'],
      },
      render: { call: 'task-update', result: 'task-update' },
      execute: ({ taskId, ...updates }) => {
        const task = self.updateTask(taskId, updates);
        if (!task) {
          return Promise.resolve({
            error: `任务不存在: ${taskId}`,
          });
        }

        if (task.status === 'deleted') {
          return Promise.resolve({
            id: task.id,
            status: 'deleted',
            message: `任务 ${taskId} 已删除`,
          });
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
   * task_clear - 清空所有任务
   */
  private createClearTool(): Tool {
    const self = this;
    return createTool({
      name: 'task_clear',
      description: `清空任务列表中的所有任务。

使用时机：
- 所有任务已完成，需要开始新的任务列表
- 当前的任务列表已过时，需要重置

注意：此操作不可逆，所有任务将被永久删除。`,
      parameters: {
        type: 'object',
        properties: {},
      },
      render: { call: 'task-clear', result: 'task-clear' },
      execute: () => {
        const count = self.tasks.size;
        self.clearTasks();
        return Promise.resolve({
          message: `已清空 ${count} 个任务`,
        });
      },
    });
  }
}
