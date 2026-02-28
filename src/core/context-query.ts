/**
 * 上下文查询构建器
 *
 * 提供链式 API 用于过滤和聚合消息
 * 从 ContextFeature 移植到内核，作为 Context 的原生能力
 */

import type { EnrichedMessage, MessageTag } from './types.js';

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
