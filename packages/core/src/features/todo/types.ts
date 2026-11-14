/**
 * Todo Feature 类型定义
 */

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/**
 * 任务类型（可选工作方式声明）
 *
 * 按工作怎样推进、怎样证明完成区分，不按功能领域区分；是策略与验收
 * 约束的载体，不是阶段门禁。other 是模型侧 kind 必填的显式兜底值：
 * 数据层合法保留，不参与五类的策略语义。与 core/types.ts 的
 * TodoTaskSnapshot.kind 内联定义保持同步（core 层不 import feature 层，现状如此）。
 */
export type TaskKind = 'investigate' | 'design' | 'implement' | 'fix' | 'verify' | 'other';

/** 合法任务类型集合（工具入参与快照恢复的校验基准） */
export const TASK_KINDS: readonly TaskKind[] = ['investigate', 'design', 'implement', 'fix', 'verify', 'other'];

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
  /** 交付物（可选）：一句短语，如「src/auth.ts」「61 项测试通过」。只写结果产物，不写过程、不重复 description */
  deliver?: string;
  /** 任务类型（可选）：不选表示不启用类型专用策略，不改变任务自身的目标与验收 */
  kind?: TaskKind;
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
  deliver?: string;
  kind?: TaskKind;
}

/**
 * 任务列表摘要
 */
export interface TodoTaskSummary {
  id: string;
  subject: string;
  deliver?: string;
  kind?: TaskKind;
  status: TaskStatus;
}

/**
 * TodoFeature 配置
 */
export interface TodoFeatureConfig {
  /** Reminder 模板文件路径 */
  reminderTemplate?: string;
  /** @deprecated 提醒间隔现由内置递进策略决定：有任务 10/15/20/25...。 */
  reminderThresholdWithTasks?: number;
  /** @deprecated 保留兼容字段，当前不再参与提醒间隔计算。 */
  reminderThresholdWithoutTasks?: number;
}
