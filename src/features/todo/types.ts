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
  /** 详细描述（可选） */
  description?: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 元数据（内部生命周期数据，不暴露给模型工具） */
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
}

/**
 * 任务列表摘要
 */
export interface TodoTaskSummary {
  id: string;
  subject: string;
  status: TaskStatus;
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
