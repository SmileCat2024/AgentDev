/**
 * Todo Feature 类型定义
 */

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
