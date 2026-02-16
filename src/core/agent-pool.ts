/**
 * AgentPool - 子代理管理核心
 * 管理父代理创建的所有子代理实例
 */

import type { Agent } from './agent.js';
import type { SubAgentStatus, SubAgentUpdateContext } from './lifecycle.js';

/**
 * 子代理实例信息
 */
interface SubAgentInstance {
  id: string;
  type: string;
  agent: Agent;
  status: SubAgentStatus;
  initialInstruction: string;
  createdAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

/**
 * Agent 创建函数类型（异步）
 */
type AgentFactory = (type: string) => Agent | Promise<Agent>;

export class AgentPool {
  private _instances = new Map<string, SubAgentInstance>();
  private _counters = new Map<string, number>();
  private _parent: Agent;

  // 子代理消息回传机制
  /** 待回传消息队列：agentId -> messages[] */
  private _pendingMessages: Map<string, string[]> = new Map();
  /** 消息就绪解析器：key -> resolver function */
  private _messageResolvers: Map<string, (message: string | null) => void> = new Map();

  constructor(parent: Agent) {
    this._parent = parent;
  }

  /**
   * 创建子代理
   */
  async spawn(type: string, instruction: string, createAgentFn: AgentFactory): Promise<string> {
    // 生成 ID: type_序号
    const count = (this._counters.get(type) || 0) + 1;
    this._counters.set(type, count);
    const id = `${type}_${count}`;

    // 创建 Agent 实例（异步）
    const agent = await createAgentFn(type);

    // 注入 agentId 和 pool 引用到子代理
    // 用于子代理回传消息
    (agent as any)._agentId = id;
    (agent as any)._parentPool = this;

    // 如果父代理启用了 debug，子代理也启用并注册到同一个 DebugHub
    if ((this._parent as any).debugEnabled && (this._parent as any).debugHub) {
      const parentDebugHub = (this._parent as any).debugHub;
      // 子代理注册到 debug 服务器
      await agent.withViewer(`${type}_${count}`);
      // 使用父代理的同一个 debugHub 实例
      (agent as any).debugHub = parentDebugHub;
    }

    // 存储实例信息
    const instance: SubAgentInstance = {
      id,
      type,
      agent,
      status: 'running',
      initialInstruction: instruction,
      createdAt: Date.now(),
    };
    this._instances.set(id, instance);

    // 触发 onSubAgentSpawn 钩子
    await this._parent.onSubAgentSpawn?.({
      agentId: id,
      type,
      agent,
      instruction,
    });

    // 异步执行指令
    agent.onCall(instruction)
      .then(result => this._onComplete(id, result))
      .catch(error => this._onError(id, error));

    return id;
  }

  /**
   * 获取实例信息
   */
  get(id: string): SubAgentInstance | undefined {
    return this._instances.get(id);
  }

  /**
   * 列出所有实例
   */
  list(filter?: SubAgentStatus): SubAgentInstance[] {
    const all = Array.from(this._instances.values());
    if (!filter) return all;
    return all.filter(i => i.status === filter);
  }

  /**
   * 向子代理发送消息
   */
  async sendTo(id: string, message: string): Promise<void> {
    const instance = this._instances.get(id);
    if (!instance) throw new Error(`子代理不存在: ${id}`);
    await instance.agent.onCall(message);
  }

  /**
   * 关闭子代理
   */
  async close(id: string, reason: string = 'manual'): Promise<void> {
    const instance = this._instances.get(id);
    if (!instance) return;

    await instance.agent.dispose();
    instance.status = 'terminated';
    this._instances.delete(id);

    await this._parent.onSubAgentDestroy?.({
      agentId: id,
      type: instance.type,
      reason: reason as any,
    });
  }

  /**
   * 子代理回传消息到父代理
   * @param agentId 子代理 ID
   * @param message 消息内容
   */
  async report(agentId: string, message: string): Promise<void> {
    // 添加到待回传队列
    if (!this._pendingMessages.has(agentId)) {
      this._pendingMessages.set(agentId, []);
    }
    this._pendingMessages.get(agentId)!.push(message);

    // 通知等待的解析器
    // 优先查找专门等待此 agent 的解析器
    const resolver = this._messageResolvers.get(agentId);
    if (resolver) {
      resolver(message);
      this._messageResolvers.delete(agentId);
      return;
    }

    // 如果没有专门解析器，查找通用等待解析器（以 wait_ 开头的）
    for (const [key, resolver] of this._messageResolvers) {
      if (key.startsWith('wait_')) {
        resolver(message);
        this._messageResolvers.delete(key);
        break;
      }
    }
  }

  /**
   * 等待任意子代理的消息（带超时）
   * @param timeout 超时时间（毫秒），默认 5000ms
   * @returns { agentId, message } 或 null（超时）
   */
  async waitForMessage(timeout: number = 5000): Promise<{ agentId: string; message: string } | null> {
    // 检查是否有待处理消息
    for (const [agentId, messages] of this._pendingMessages) {
      if (messages.length > 0) {
        const message = messages.shift()!;
        if (messages.length === 0) {
          this._pendingMessages.delete(agentId);
        }
        return { agentId, message };
      }
    }

    // 等待新消息或超时
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时，移除解析器
        const tempKey = `wait_${Date.now()}`;
        this._messageResolvers.delete(tempKey);
        resolve(null);
      }, timeout);

      // 临时存储解析器（任意子代理都可以触发）
      const tempKey = `wait_${Date.now()}`;
      this._messageResolvers.set(tempKey, () => {
        clearTimeout(timer);
        // 查找发送消息的 agentId
        for (const [agentId, messages] of this._pendingMessages) {
          if (messages.length > 0) {
            const message = messages.shift()!;
            if (messages.length === 0) {
              this._pendingMessages.delete(agentId);
            }
            resolve({ agentId, message });
            return;
          }
        }
        resolve(null);
      });
    });
  }

  /**
   * 检查是否有活跃的子代理或待处理的消息
   */
  hasActiveAgents(): boolean {
    // 检查是否有正在运行的子代理
    for (const instance of this._instances.values()) {
      if (instance.status === 'running') {
        return true;
      }
    }
    // 检查是否有待回传的消息
    for (const messages of this._pendingMessages.values()) {
      if (messages.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 关闭所有子代理
   */
  async shutdown(): Promise<void> {
    const promises = Array.from(this._instances.keys())
      .map(id => this.close(id, 'parent_dispose'));
    await Promise.all(promises);
  }

  // 内部方法
  private async _onComplete(id: string, result: string): Promise<void> {
    const instance = this._instances.get(id);
    if (!instance) return;

    const oldStatus = instance.status;
    instance.status = 'completed';
    instance.result = result;
    instance.completedAt = Date.now();

    // 回传消息给主代理
    await this.report(id, result);

    await this._parent.onSubAgentUpdate?.({
      agentId: id,
      type: instance.type,
      oldStatus,
      newStatus: 'completed',
      result,
    });
  }

  private async _onError(id: string, error: Error): Promise<void> {
    const instance = this._instances.get(id);
    if (!instance) return;

    const oldStatus = instance.status;
    instance.status = 'failed';
    instance.error = error.message;
    instance.completedAt = Date.now();

    await this._parent.onSubAgentUpdate?.({
      agentId: id,
      type: instance.type,
      oldStatus,
      newStatus: 'failed',
      error: error.message,
    });
  }
}
