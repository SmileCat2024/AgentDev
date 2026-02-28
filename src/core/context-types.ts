/**
 * ContextFeature 类型定义
 *
 * 定义 EnrichedMessage、MessageTag、ParsedContent 等上下文管理相关类型
 */

import type { Message } from './types.js';

// 前向声明 ContextFeature 类（定义在 features/context.ts）
export type { ContextFeature } from '../features/context.js';

/**
 * 消息标签枚举
 *
 * 用于快速分类和过滤消息，一条消息可能有多个标签
 */
export type MessageTag =
  | 'user'           // 用户输入消息
  | 'system'         // 系统消息
  | 'assistant'      // LLM 响应消息
  | 'tool-call'      // assistant 消息且包含 toolCalls
  | 'tool-result'    // role === 'tool' 的工具执行结果
  | 'sub-agent'      // 来自子代理的消息（与 assistant/tool-result 组合使用）
  | 'reminder';      // Feature 注入的提醒消息（与 system 组合使用）

/**
 * 解析结果结构
 *
 * 从消息 content 中提取的结构化信息
 * 用户继承 ContextFeature 可扩展此接口
 */
export interface ParsedContent {
  /** 从 content 提取的任务 ID（正则匹配 "taskId":"xxx"） */
  taskIds: string[];
  /** 从 content 提取的工具调用名称（从 toolCalls 或 content 解析） */
  toolCalls: string[];
  /** @ 提及的内容 */
  mentions: string[];
  /** 用户可继承扩展更多字段 */
  [key: string]: any;
}

/**
 * Feed 元数据
 *
 * 调用 ContextFeature.feed() 时传递的元数据
 */
export interface FeedMetadata {
  /** ReAct 循环轮次 */
  turn: number;
  /** 子代理 ID（子代理消息时填写） */
  agentId?: string;
  /** 来源 Feature（reminder 等消息时填写） */
  source?: string;
}

/**
 * ContextFeature 配置
 */
export interface ContextFeatureConfig {
  /** 是否启用调试日志 */
  debug?: boolean;
}

/**
 * 扩展的消息结构
 *
 * 在原始 Message 基础上添加元数据，只在 ContextFeature 内部使用
 * 不破坏现有 Message 类型，保证 LLM 调用兼容性
 */
export interface EnrichedMessage extends Message {
  // === 元数据字段 ===

  /** 唯一标识（用于索引关联） */
  id: string;
  /** 消息产生时间戳（毫秒） */
  timestamp: number;
  /** 所属 ReAct 循环轮次（从 0 开始） */
  turn: number;
  /** 全局消息序号（从 0 开始递增） */
  sequence: number;
  /** 来源 Agent ID（子代理消息） */
  agentId?: string;
  /** 来源 Feature（如 'todo-feature'，仅 reminder 等） */
  source?: string;

  // === 分类标签 ===

  /** 消息分类标签（用于快速查询） */
  tags: MessageTag[];

  // === 解析结果 ===

  /** 从 content 中提取的结构化信息 */
  parsed: ParsedContent;
}
