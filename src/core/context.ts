/**
 * 上下文管理器
 * 管理消息数组，提供简单的操作方法
 *
 * 内核化能力：
 * - 消息元数据包装（EnrichedMessage）
 * - 内容解析和索引
 * - 查询接口
 */

import type {
  Message,
  ToolCall,
  LLMResponse,
  EnrichedMessage,
  MessageMeta,
  MessageTag,
  ParsedContent,
} from './types.js';
import { cloneMessages } from './message.js';
import { ContextQuery } from './context-query.js';

/**
 * 工具执行结果（用于 addToolMessage）
 */
export interface ToolExecResult {
  success: boolean;
  result: string | Record<string, any>;
  error?: string;
}

/**
 * 上下文快照类型 - 用于序列化
 */
export interface ContextSnapshot {
  version: number;
  messages: Message[];
}

export class Context {
  // ========== 字段 ==========

  private messages: Message[] = [];

  // 新增字段：内核化能力
  private enrichedMessages: EnrichedMessage[] = [];
  private indexes = new Map<string, Set<string>>();
  private sequence: number = 0;

  /**
   * 添加一条消息
   */
  add(message: Message): this {
    this.messages.push({ ...message });
    return this;
  }

  /**
   * 添加多条消息
   */
  addAll(messages: Message[]): this {
    for (const m of messages) {
      this.add(m);
    }
    return this;
  }

  /**
   * 获取所有消息的副本
   */
  getAll(): Message[] {
    return cloneMessages(this.messages);
  }

  /**
   * 获取消息数量
   */
  get length(): number {
    return this.messages.length;
  }

  /**
   * 获取最后一条消息
   */
  getLast(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * 清空消息
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * 应用中间件处理消息
   */
  apply(middleware: (messages: Message[]) => Message[]): this {
    this.messages = middleware(this.messages);
    return this;
  }

  /**
   * 过滤消息
   */
  filter(predicate: (msg: Message) => boolean): Message[] {
    return this.messages.filter(predicate);
  }

  /**
   * 切片
   */
  slice(start?: number, end?: number): Message[] {
    return this.messages.slice(start, end);
  }

  /**
   * 序列化为快照
   */
  toJSON(): ContextSnapshot {
    return {
      version: 1,
      messages: cloneMessages(this.messages),
    };
  }

  /**
   * 从快照恢复
   */
  static fromJSON(snapshot: ContextSnapshot): Context {
    const ctx = new Context();
    ctx.messages = cloneMessages(snapshot.messages);
    return ctx;
  }

  /**
   * 序列化为 JSON 字符串
   */
  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  /**
   * 从 JSON 字符串反序列化
   */
  static deserialize(json: string): Context {
    return Context.fromJSON(JSON.parse(json));
  }

  // ========== 内核化能力：消息包装 ==========

  /**
   * 统一消息入口（内部方法）
   */
  private addMessage(msg: Message, meta: MessageMeta): void {
    const enriched = this.enrich(msg, meta);
    this.enrichedMessages.push(enriched);
    this.updateIndexes(enriched);
  }

  /**
   * 添加用户消息
   */
  addUserMessage(content: string, turn: number): void {
    this.addMessage(
      { role: 'user', content },
      { turn }
    );
    // 同步到 messages 数组（保持向后兼容）
    this.messages.push({ role: 'user', content });
  }

  /**
   * 添加助手响应
   */
  addAssistantMessage(response: LLMResponse, turn: number): void {
    this.addMessage(
      {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
        reasoning: response.reasoning,
      },
      { turn }
    );
    // 同步到 messages 数组
    this.messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      reasoning: response.reasoning,
    });
  }

  /**
   * 添加工具结果
   */
  addToolMessage(call: ToolCall, result: ToolExecResult, turn: number): void {
    const content = JSON.stringify({
      success: result.success,
      result: result.result,
      ...(result.error ? { error: result.error } : {}),
    });
    this.addMessage(
      {
        role: 'tool',
        toolCallId: call.id,
        content,
      },
      { turn }
    );
    // 同步到 messages 数组
    this.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content,
    });
  }

  /**
   * 添加系统消息
   */
  addSystemMessage(content: string, turn: number, source?: string): void {
    this.addMessage(
      { role: 'system', content },
      { turn, source }
    );
    // 同步到 messages 数组
    this.messages.push({ role: 'system', content });
  }

  // ========== 内核化能力：查询接口 ==========

  /**
   * 查询构建器
   */
  query(): ContextQuery {
    return new ContextQuery(this.enrichedMessages, this.indexes);
  }

  /**
   * 按轮次获取消息
   */
  getByTurn(turn: number): EnrichedMessage[] {
    return this.enrichedMessages.filter(m => m.turn === turn);
  }

  /**
   * 获取最近 N 条消息
   */
  getRecent(n: number): EnrichedMessage[] {
    return this.enrichedMessages.slice(-n);
  }

  /**
   * 获取所有丰富化消息（内部使用）
   */
  getAllEnriched(): EnrichedMessage[] {
    return [...this.enrichedMessages];
  }

  // ========== 私有方法 ==========

  /**
   * 丰富化消息：添加元数据
   */
  private enrich(message: Message, meta: MessageMeta): EnrichedMessage {
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
      turn: meta.turn,
      sequence: this.sequence++,
      agentId: meta.agentId,
      source: meta.source,

      // 分类标签
      tags: this.inferTags(message),

      // 解析结果
      parsed: this.parseContent(message),
    };
  }

  /**
   * 推断消息标签
   */
  private inferTags(message: Message): MessageTag[] {
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
   * 解析 content 提取结构化信息
   */
  private parseContent(message: Message): ParsedContent {
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
   */
  private updateIndexes(message: EnrichedMessage): void {
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
   * 生成唯一 ID
   */
  private generateId(): string {
    return `msg_${Date.now()}_${this.sequence}`;
  }
}
