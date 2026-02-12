/**
 * 上下文管理器
 * 管理消息数组，提供简单的操作方法
 */

import type { Message } from './types.js';
import { cloneMessages } from './message.js';

/**
 * 上下文快照类型 - 用于序列化
 */
export interface ContextSnapshot {
  version: number;
  messages: Message[];
}

export class Context {
  private messages: Message[] = [];

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
}
