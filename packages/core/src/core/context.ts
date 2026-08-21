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
  ImageInput,
  MessageExecutionMeta,
} from './types.js';
import { cloneMessages } from './message.js';
import { ContextQuery } from './context-query.js';
import { emitAssistantResponseEvents, emitToolResultEvents } from './session-events.js';

/**
 * 深拷贝 enriched 消息（tags/parsed 独立副本）。
 */
function cloneEnrichedMessages(messages: EnrichedMessage[]): EnrichedMessage[] {
  return messages.map(message => ({
    ...message,
    tags: [...message.tags],
    parsed: { ...message.parsed },
  }));
}

/**
 * 深拷贝 tombstone 条目。
 */
function cloneTombstone(entry: ContextTombstoneEntry): ContextTombstoneEntry {
  return {
    id: entry.id,
    boundary: { ...entry.boundary },
    removedMessageCount: entry.removedMessageCount,
    truncatedAt: entry.truncatedAt,
    removedMessages: cloneMessages(entry.removedMessages),
    removedEnrichedMessages: cloneEnrichedMessages(entry.removedEnrichedMessages),
  };
}

/**
 * 工具执行结果（用于 addToolMessage）
 */
export interface ToolExecResult {
  success: boolean;
  result: string | Record<string, any>;
  error?: string;
  /** 工具返回的图片（注入到 tool 消息，视觉模式下传给 LLM） */
  images?: ImageInput[];
  /** 前端展示数据（不注入 LLM，仅 tool 消息） */
  display?: unknown;
}

/**
 * 上下文快照类型 - 用于序列化
 */
export interface ContextSnapshot {
  version: number;
  messages: Message[];
  enrichedMessages?: EnrichedMessage[];
  sequence?: number;
  generation?: number;
  /** 截断归档（tombstone）。旧快照可能没有该字段，加载时视为空归档。 */
  tombstones?: ContextTombstoneEntry[];
}

/**
 * Context 边界快照 — 用于增量 rollback。
 *
 * 记录某个时间点两个数组的长度、sequence 和 generation，
 * 截断时只需按长度切片即可恢复到该边界。
 *
 * generation 用于防止 ABA 问题：如果 Context 经历了
 * clear/apply/restore 等非追加 mutation，generation 会递增，
 * 旧 boundary 会被拒绝。
 */
export interface ContextBoundaryV2 {
  messagesLength: number;
  enrichedMessagesLength: number;
  sequence: number;
  generation: number;
}

/**
 * Tombstone 摘要 — 轻量元数据，不含消息内容。
 */
export interface ContextTombstoneSummary {
  /** 单调递增的 tombstone ID（同一 Context 实例内唯一） */
  id: number;
  /** 截断恢复到的边界 */
  boundary: ContextBoundaryV2;
  /** 被截断的消息条数 */
  removedMessageCount: number;
  /** 截断发生时间（ISO 字符串） */
  truncatedAt: string;
}

/**
 * Tombstone 完整条目 — 含被截断的消息内容。
 *
 * rollback 截断不再物理丢失内容：被截尾部进入 tombstone 归档，
 * 可查询（listTombstones / getTombstone），在 Context 仍处于该边界时
 * 可完整恢复（restoreTombstone）。
 */
export interface ContextTombstoneEntry extends ContextTombstoneSummary {
  removedMessages: Message[];
  removedEnrichedMessages: EnrichedMessage[];
}

export class Context {
  // ========== 字段 ==========

  private messages: Message[] = [];

  // 新增字段：内核化能力
  private enrichedMessages: EnrichedMessage[] = [];
  private indexes = new Map<string, Set<string>>();
  private sequence: number = 0;

  /**
   * Lineage generation，用于检测非追加 mutation。
   *
   * - 纯追加 typed message（addUserMessage 等）：不变
   * - rollback 的合法截断（truncateToBoundary）：不变
   * - clear / apply：递增
   * - restore：使用 snapshot 携带的 generation，否则递增
   */
  private generation: number = 0;

  /**
   * 截断归档（tombstone）。append-only：clear/apply/restore 不清空，
   * 只有 restore(snapshot) 采用快照携带的归档。
   */
  private tombstones: ContextTombstoneEntry[] = [];
  private tombstoneSeq: number = 0;

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
    this.generation++;
  }

  /**
   * 应用中间件处理消息
   */
  apply(middleware: (messages: Message[]) => Message[]): this {
    this.messages = middleware(this.messages);
    this.generation++;
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
      version: 2,
      messages: cloneMessages(this.messages),
      enrichedMessages: cloneEnrichedMessages(this.enrichedMessages),
      sequence: this.sequence,
      generation: this.generation,
      tombstones: this.tombstones.map(cloneTombstone),
    };
  }

  /**
   * 从快照恢复
   */
  static fromJSON(snapshot: ContextSnapshot): Context {
    const ctx = new Context();
    ctx.restore(snapshot);
    return ctx;
  }

  /**
   * 用快照原地恢复当前 Context
   */
  restore(snapshot: ContextSnapshot): this {
    this.messages = cloneMessages(snapshot.messages);
    this.enrichedMessages = snapshot.enrichedMessages
      ? cloneEnrichedMessages(snapshot.enrichedMessages)
      : [];
    this.sequence = snapshot.sequence ?? this.enrichedMessages.length;
    this.generation = snapshot.generation ?? this.generation + 1;
    this.tombstones = snapshot.tombstones
      ? snapshot.tombstones.map(cloneTombstone)
      : [];
    this.tombstoneSeq = this.tombstones.reduce((max, t) => Math.max(max, t.id), 0);
    this.rebuildIndexes();
    return this;
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
  addUserMessage(content: string, turn: number, images?: ImageInput[]): void {
    this.addMessage(
      { role: 'user', content, turn, images },
      { turn }
    );
    // 同步到 messages 数组（保持向后兼容）
    this.messages.push({ role: 'user', content, turn, images });
  }

  /**
   * 添加助手响应
   *
   * 框架合成消息（错误/截断说明）可通过 execution 字段附带执行终态元数据。
   */
  addAssistantMessage(response: LLMResponse & { execution?: MessageExecutionMeta }, turn: number): void {
    // 会话事件流：reasoning / agent_message / tool_call started
    emitAssistantResponseEvents(response, turn);

    // 从 LLM 响应中提取用量信息，盖戳到 assistant 消息上
    const usage = response.usage
      ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
      : undefined;
    // 框架盖戳的执行终态元数据（错误/截断消息）原样透传到消息上
    const { execution } = response;

    this.addMessage(
      {
        role: 'assistant',
        content: response.content,
        turn,
        toolCalls: response.toolCalls,
        reasoning: response.reasoning,
        thinkingBlocks: response.thinkingBlocks,
        usage,
        ...(execution ? { execution } : {}),
      },
      { turn }
    );
    // 同步到 messages 数组
    this.messages.push({
      role: 'assistant',
      content: response.content,
      turn,
      toolCalls: response.toolCalls,
      reasoning: response.reasoning,
      thinkingBlocks: response.thinkingBlocks,
      usage,
      ...(execution ? { execution } : {}),
    });
  }

  /**
   * 添加工具结果
   */
  addToolMessage(call: ToolCall, result: ToolExecResult, turn: number): void {
    // 会话事件流：tool_call completed
    emitToolResultEvents(call, result, turn);

    const content = JSON.stringify({
      success: result.success,
      result: result.result,
      ...(result.error ? { error: result.error } : {}),
    });
    this.addSerializedToolMessage(call.id, content, turn, result.images, result.display);
  }

  /**
   * 添加已经序列化的工具消息。
   *
   * 用于 session/handoff 恢复等边界：原始 tool content 已经是 provider 可重放的
   * 序列化字符串，不应先解析成 ToolExecResult 再重新编码。该入口同时维护
   * messages[] 与 enrichedMessages[]，并保留工具返回的图片附件。
   */
  addSerializedToolMessage(toolCallId: string, content: string, turn: number, images?: ImageInput[], display?: unknown): void {
    const normalizedImages = images?.length ? images : undefined;
    const message: Message = {
      role: 'tool',
      turn,
      toolCallId,
      content,
      ...(normalizedImages ? { images: normalizedImages } : {}),
      ...(display !== undefined ? { display } : {}),
    };
    this.addMessage(message, { turn });
    this.messages.push({ ...message });
  }

  /**
   * 添加系统消息
   */
  addSystemMessage(content: string, turn: number, source?: string, tag?: string): void {
    this.addMessage(
      { role: 'system', content, turn, ...(tag ? { tag } : {}) },
      { turn, source, ...(tag ? { tag } : {}) }
    );
    // 同步到 messages 数组
    this.messages.push({ role: 'system', content, turn, ...(source ? { source } : {}), ...(tag ? { tag } : {}) });
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
      thinkingBlocks: message.thinkingBlocks,
      images: message.images,

      // 元数据字段
      id,
      timestamp,
      turn: meta.turn,
      sequence: this.sequence++,
      agentId: meta.agentId,
      source: meta.source,
      tag: message.tag ?? meta.tag,

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
   * 从 enrichedMessages 重建索引
   */
  private rebuildIndexes(): void {
    this.indexes = new Map<string, Set<string>>();
    for (const message of this.enrichedMessages) {
      this.updateIndexes(message);
    }
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `msg_${Date.now()}_${this.sequence}`;
  }

  // ========== 边界原语（增量 rollback） ==========

  /**
   * 捕获当前 Context 的前缀边界。
   *
   * 返回一个轻量快照，记录两个数组的长度、sequence 和 generation。
   * 后续可传给 truncateToBoundary() 恢复到此边界。
   *
   * generation 不变：纯读取操作。
   */
  captureBoundary(): ContextBoundaryV2 {
    return {
      messagesLength: this.messages.length,
      enrichedMessagesLength: this.enrichedMessages.length,
      sequence: this.sequence,
      generation: this.generation,
    };
  }

  /**
   * 校验 boundary 是否与当前 Context 兼容。
   *
   * @throws 如果 generation 不匹配、长度非法或超出当前数组。
   */
  private assertBoundaryCompatible(boundary: ContextBoundaryV2): void {
    if (boundary.generation !== this.generation) {
      throw new Error(
        `Context boundary generation mismatch: boundary=${boundary.generation}, current=${this.generation}. ` +
          'Context has been mutated by clear/apply/restore since the boundary was captured.',
      );
    }
    if (!Number.isInteger(boundary.messagesLength) || boundary.messagesLength < 0) {
      throw new Error(
        `Context boundary messagesLength must be a non-negative integer, got ${boundary.messagesLength}`,
      );
    }
    if (
      !Number.isInteger(boundary.enrichedMessagesLength) ||
      boundary.enrichedMessagesLength < 0
    ) {
      throw new Error(
        `Context boundary enrichedMessagesLength must be a non-negative integer, got ${boundary.enrichedMessagesLength}`,
      );
    }
    if (boundary.messagesLength > this.messages.length) {
      throw new Error(
        `Context boundary messagesLength (${boundary.messagesLength}) exceeds current length (${this.messages.length})`,
      );
    }
    if (boundary.enrichedMessagesLength > this.enrichedMessages.length) {
      throw new Error(
        `Context boundary enrichedMessagesLength (${boundary.enrichedMessagesLength}) exceeds current length (${this.enrichedMessages.length})`,
      );
    }
  }

  /**
   * 将两个数组截断到指定边界。
   *
   * 这是合法的 rollback 操作：generation 保持不变，
   * 截断后同一 lineage 的旧 boundary 仍然可以继续使用。
   *
   * 被截尾部进入 tombstone 归档（不物理丢失）：
   * 通过 listTombstones() / getTombstone() 查询，
   * Context 仍处于该边界时可通过 restoreTombstone() 完整恢复。
   *
   * @throws 如果 boundary 与当前 Context 不兼容（generation 不匹配或长度越界）。
   */
  truncateToBoundary(boundary: ContextBoundaryV2): void {
    this.assertBoundaryCompatible(boundary);

    const removedMessages = this.messages.slice(boundary.messagesLength);
    const removedEnrichedMessages = this.enrichedMessages.slice(
      boundary.enrichedMessagesLength,
    );

    if (removedMessages.length > 0 || removedEnrichedMessages.length > 0) {
      this.tombstones.push({
        id: ++this.tombstoneSeq,
        boundary: { ...boundary },
        truncatedAt: new Date().toISOString(),
        removedMessageCount: removedMessages.length,
        removedMessages: cloneMessages(removedMessages),
        removedEnrichedMessages: cloneEnrichedMessages(removedEnrichedMessages),
      });
    }

    this.messages = this.messages.slice(0, boundary.messagesLength);
    this.enrichedMessages = this.enrichedMessages.slice(
      0,
      boundary.enrichedMessagesLength,
    );
    this.sequence = boundary.sequence;
    this.rebuildIndexes();
  }

  // ========== Tombstone 归档（诚实反悔：被截内容不物理丢失） ==========

  /**
   * 列出 tombstone 摘要（不含消息内容）。
   */
  listTombstones(): ContextTombstoneSummary[] {
    return this.tombstones.map(entry => ({
      id: entry.id,
      boundary: { ...entry.boundary },
      removedMessageCount: entry.removedMessageCount,
      truncatedAt: entry.truncatedAt,
    }));
  }

  /**
   * 按 ID 取回 tombstone 完整内容（深拷贝，修改返回值不影响归档）。
   */
  getTombstone(id: number): ContextTombstoneEntry | undefined {
    const entry = this.tombstones.find(t => t.id === id);
    return entry ? cloneTombstone(entry) : undefined;
  }

  /**
   * 从 tombstone 恢复被截尾部。
   *
   * 仅当 Context 仍精确处于该 tombstone 的边界时允许
   * （generation、两个数组长度、sequence 全部匹配）——此时恢复是
   * 截断的精确逆操作，不破坏 lineage。
   *
   * 恢复后 sequence 续接被截尾部的最大序号，generation 不变。
   *
   * @throws 如果 Context 已离开该边界（例如截断后追加了新消息）。
   *         此时内容仍可通过 getTombstone() 提取，由调用方决定如何重组。
   */
  restoreTombstone(id: number): void {
    const entry = this.tombstones.find(t => t.id === id);
    if (!entry) {
      throw new Error(`Tombstone ${id} not found`);
    }

    const b = entry.boundary;
    const atBoundary =
      b.generation === this.generation &&
      b.messagesLength === this.messages.length &&
      b.enrichedMessagesLength === this.enrichedMessages.length &&
      b.sequence === this.sequence;

    if (!atBoundary) {
      throw new Error(
        `Cannot restore tombstone ${id}: context is no longer at the tombstone boundary ` +
          `(boundary: generation=${b.generation}, messagesLength=${b.messagesLength}, ` +
          `enrichedMessagesLength=${b.enrichedMessagesLength}, sequence=${b.sequence}; ` +
          `current: generation=${this.generation}, messagesLength=${this.messages.length}, ` +
          `enrichedMessagesLength=${this.enrichedMessages.length}, sequence=${this.sequence}). ` +
          'Extract the content via getTombstone() instead.',
      );
    }

    this.messages = [...this.messages, ...cloneMessages(entry.removedMessages)];
    this.enrichedMessages = [
      ...this.enrichedMessages,
      ...cloneEnrichedMessages(entry.removedEnrichedMessages),
    ];
    const lastRestored =
      entry.removedEnrichedMessages[entry.removedEnrichedMessages.length - 1];
    if (lastRestored) {
      this.sequence = lastRestored.sequence + 1;
    }
    this.rebuildIndexes();
  }
}
