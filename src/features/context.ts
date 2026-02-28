/**
 * ContextFeature - 上下文管理功能模块
 *
 * 提供消息的元数据包装、索引和查询能力
 * 其他 Feature 通过 ContextFeature 优雅地访问和查询对话上下文
 *
 * @example
 * ```typescript
 * agent.use(new ContextFeature());
 *
 * // 在其他 Feature 中使用
 * const context = ctx.getContextFeature();
 * const lastUpdate = context.query().byTool('task_update').last();
 * ```
 */

import { createTool } from '../core/tool.js';
import type { Tool } from '../core/types.js';
import type { Message } from '../core/types.js';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
} from '../core/feature.js';
import type {
  MessageTag,
  ParsedContent,
  EnrichedMessage,
  FeedMetadata,
} from '../core/context-types.js';

// ========== ContextQuery - 查询构建器 ==========

/**
 * 上下文查询构建器
 *
 * 提供链式 API 用于过滤和聚合消息
 */
export class ContextQuery {
  constructor(
    private messages: EnrichedMessage[],
    private indexes: Map<string, Set<string>>
  ) {
    this.result = [...messages];
  }

  private result: EnrichedMessage[];

  // ========== 过滤方法 ==========

  /**
   * 按角色过滤
   */
  byRole(...roles: string[]): this {
    this.result = this.result.filter(m => roles.includes(m.role));
    return this;
  }

  /**
   * 按标签过滤（可组合）
   */
  byTag(...tags: MessageTag[]): this {
    this.result = this.result.filter(m =>
      m.tags?.some(t => tags.includes(t))
    );
    return this;
  }

  /**
   * 按工具名过滤（使用索引加速）
   */
  byTool(name: string): this {
    const key = `tool:${name}`;
    const ids = this.indexes.get(key);
    if (ids) {
      this.result = this.result.filter(m => ids.has(m.id));
    }
    return this;
  }

  /**
   * 按任务 ID 过滤（使用索引加速）
   */
  byTask(taskId: string): this {
    const key = `task:${taskId}`;
    const ids = this.indexes.get(key);
    if (ids) {
      this.result = this.result.filter(m => ids.has(m.id));
    }
    return this;
  }

  /**
   * 按子代理 ID 过滤
   */
  byAgentId(agentId: string): this {
    this.result = this.result.filter(m => m.agentId === agentId);
    return this;
  }

  /**
   * 按时间起点过滤
   */
  since(timestamp: number): this {
    this.result = this.result.filter(m => m.timestamp >= timestamp);
    return this;
  }

  /**
   * 按轮次范围过滤
   */
  inTurns(from: number, to?: number): this {
    this.result = this.result.filter(m => {
      if (to === undefined) return m.turn >= from;
      return m.turn >= from && m.turn <= to;
    });
    return this;
  }

  /**
   * content 包含指定文本
   */
  containing(text: string): this {
    this.result = this.result.filter(m =>
      m.content.includes(text)
    );
    return this;
  }

  /**
   * 最近 N 条
   */
  recent(n: number): this {
    this.result = this.result.slice(-n);
    return this;
  }

  // ========== 聚合方法 ==========

  /**
   * 执行查询，返回结果数组
   */
  exec(): EnrichedMessage[] {
    return this.result;
  }

  /**
   * 获取第一条
   */
  first(): EnrichedMessage | undefined {
    return this.result[0];
  }

  /**
   * 获取最后一条
   */
  last(): EnrichedMessage | undefined {
    return this.result[this.result.length - 1];
  }

  /**
   * 计数
   */
  count(): number {
    return this.result.length;
  }

  /**
   * 时间跨度统计
   */
  timeSpan(): { start: number; end: number; duration: number } {
    if (this.result.length === 0) {
      return { start: 0, end: 0, duration: 0 };
    }
    const start = this.result[0].timestamp;
    const end = this.result[this.result.length - 1].timestamp;
    return { start, end, duration: end - start };
  }

  /**
   * 按工具分组统计
   */
  groupByTool(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const msg of this.result) {
      msg.toolCalls?.forEach(call => {
        stats[call.name] = (stats[call.name] ?? 0) + 1;
      });
    }
    return stats;
  }
}

// ========== ContextFeature ==========

/**
 * ContextFeature 配置
 */
export interface ContextFeatureConfig {
  /** 是否启用调试日志 */
  debug?: boolean;
}

/**
 * ContextFeature 实现
 *
 * 核心职责：
 * 1. 接收原始 Message，包装为 EnrichedMessage
 * 2. 解析 content，提取结构化信息
 * 3. 建立索引（按工具名、taskId 等）
 * 4. 提供查询接口
 */
export class ContextFeature implements AgentFeature {
  readonly name = 'context';
  readonly dependencies: string[] = [];

  private messages: EnrichedMessage[] = [];
  private indexes = new Map<string, Set<string>>();
  private sequence = 0;
  private config: ContextFeatureConfig;

  constructor(config?: ContextFeatureConfig) {
    this.config = config ?? {};
  }

  // ========== AgentFeature 接口实现 ==========

  getTools(): Tool[] {
    // ContextFeature 不提供工具，纯服务型 Feature
    return [];
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    // 初始化逻辑
    if (this.config.debug) {
      console.log('[ContextFeature] Initialized');
    }
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 清理逻辑
    this.clear();
    if (this.config.debug) {
      console.log('[ContextFeature] Destroyed');
    }
  }

  // ========== 数据写入接口 ==========

  /**
   * 单条消息注入（由 Agent/ReActLoop 调用）
   *
   * @param message 原始消息
   * @param feed 元数据（turn, agentId, source）
   */
  feed(message: Message, feed: FeedMetadata): void {
    const enriched = this.enrich(message, feed);
    this.messages.push(enriched);
    this.updateIndexes(enriched);
  }

  /**
   * 批量加载历史消息（初始化时）
   *
   * @param messages 原始消息数组
   */
  load(messages: Message[]): void {
    this.messages = messages.map((m, i) =>
      this.enrich(m, { turn: 0 })
    );
    this.rebuildIndexes();
  }

  /**
   * 清空所有消息
   */
  clear(): void {
    this.messages = [];
    this.indexes.clear();
    this.sequence = 0;
  }

  // ========== 查询接口 ==========

  /**
   * 查询构建器
   *
   * @returns ContextQuery 实例
   */
  query(): ContextQuery {
    return new ContextQuery(this.messages, this.indexes);
  }

  /**
   * 获取所有消息的副本
   */
  getAll(): EnrichedMessage[] {
    return [...this.messages];
  }

  /**
   * 获取消息数量
   */
  get length(): number {
    return this.messages.length;
  }

  // ========== 内部方法（可覆盖） ==========

  /**
   * 推断消息标签（用户可覆盖）
   *
   * @param message 原始消息
   * @returns 标签数组
   */
  protected inferTags(message: Message): MessageTag[] {
    const tags: MessageTag[] = [];

    if (message.role === 'user') {
      tags.push('user');
    } else if (message.role === 'system') {
      tags.push('system');
    } else if (message.role === 'assistant') {
      tags.push('assistant');
      if (message.toolCalls && message.toolCalls.length > 0) {
        tags.push('tool-call');
      }
    } else if (message.role === 'tool') {
      tags.push('tool-result');
    }

    return tags;
  }

  /**
   * 解析 content 提取结构化信息（用户可覆盖）
   *
   * @param message 原始消息
   * @returns 解析结果
   */
  protected parseContent(message: Message): ParsedContent {
    const content = message.content;

    // 提取 taskId: 匹配 "taskId":"xxx" 或 'taskId':'xxx'
    const taskIdRegex = /["']taskId["']\s*:\s*["']([^"']+)["']/g;
    const taskIds: string[] = [];
    let match;
    while ((match = taskIdRegex.exec(content)) !== null) {
      taskIds.push(match[1]);
    }

    // 提取工具调用名：从 toolCalls 或 content 中提取
    const toolCalls: string[] = [];
    if (message.toolCalls) {
      message.toolCalls.forEach(call => toolCalls.push(call.name));
    }

    // 提取 @ 提及
    const mentions: string[] = [];
    const mentionRegex = /@(\w+)/g;
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }

    return { taskIds, toolCalls, mentions };
  }

  /**
   * 更新索引
   *
   * @param message 丰富化后的消息
   */
  protected updateIndexes(message: EnrichedMessage): void {
    // 按工具名索引
    message.toolCalls?.forEach(call => {
      const key = `tool:${call.name}`;
      const set = this.indexes.get(key) ?? new Set<string>();
      set.add(message.id);
      this.indexes.set(key, set);
    });

    // 按 taskId 索引
    message.parsed.taskIds.forEach(taskId => {
      const key = `task:${taskId}`;
      const set = this.indexes.get(key) ?? new Set<string>();
      set.add(message.id);
      this.indexes.set(key, set);
    });
  }

  /**
   * 重建所有索引
   */
  protected rebuildIndexes(): void {
    this.indexes.clear();
    for (const msg of this.messages) {
      this.updateIndexes(msg);
    }
  }

  // ========== 私有方法 ==========

  /**
   * 丰富化消息：添加元数据
   */
  private enrich(message: Message, feed: FeedMetadata): EnrichedMessage {
    const id = this.generateId();
    const timestamp = Date.now();

    return {
      // 原始字段
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      reasoning: message.reasoning,

      // 元数据字段
      id,
      timestamp,
      turn: feed.turn,
      sequence: this.sequence++,
      agentId: feed.agentId,
      source: feed.source,

      // 分类标签
      tags: this.inferTags(message),

      // 解析结果
      parsed: this.parseContent(message),
    };
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `msg_${Date.now()}_${this.sequence}`;
  }
}
