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
   * 创建子代理（不自动执行，等待 sendTo 激活）
   */
  async spawn(type: string, createAgentFn: AgentFactory): Promise<string> {
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
      status: 'idle',
      initialInstruction: '',
      createdAt: Date.now(),
    };
    this._instances.set(id, instance);

    // 触发 onSubAgentSpawn 钩子
    await this._parent.onSubAgentSpawn?.({
      agentId: id,
      type,
      agent,
      instruction: '',
    });

    // 子代理创建后处于空闲状态，等待 sendTo 激活
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
   * 向子代理发送消息（非阻塞）
   */
  async sendTo(id: string, message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(`[DEBUG:sendTo] ${timestamp} agentId=${id}, msg="${message.slice(0, 50)}..."`);

    const instance = this._instances.get(id);
    if (!instance) throw new Error(`子代理不存在: ${id}`);

    // 更新状态为 busy
    const oldStatus = instance.status;
    instance.status = 'busy';
    console.log(`[DEBUG:sendTo] 状态: ${oldStatus} -> busy`);

    // 异步执行，立即返回
    instance.agent.onCall(message)
      .then(result => {
        const thenTime = new Date().toISOString();
        console.log(`[DEBUG:sendTo.then] ${thenTime} agentId=${id}, 完成，result="${result.slice(0, 50)}..."`);
        // 正常完成
        instance.status = 'idle';
        instance.result = result;
        // 报告消息（入队）
        this.report(id, result);
      })
      .catch(error => {
        const catchTime = new Date().toISOString();
        console.log(`[DEBUG:sendTo.catch] ${catchTime} agentId=${id}, error=${error.message}`);
        // 执行失败
        instance.status = 'failed';
        this._onError(id, error);
      });
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
    const timestamp = new Date().toISOString();
    const msgPreview = message.slice(0, 50);

    console.log(`[DEBUG:report] ${timestamp} agentId=${agentId}, msg="${msgPreview}..."`);
    console.trace('[DEBUG:report] 调用栈:');

    // 添加到待回传队列
    if (!this._pendingMessages.has(agentId)) {
      this._pendingMessages.set(agentId, []);
    }
    this._pendingMessages.get(agentId)!.push(message);

    console.log(`[DEBUG:report] 入队后队列长度: ${this._pendingMessages.get(agentId)!.length}`);

    // 通知等待的解析器
    // 优先查找专门等待此 agent 的解析器
    const resolver = this._messageResolvers.get(agentId);
    if (resolver) {
      console.log(`[DEBUG:report] 触发专门 resolver: ${agentId}`);
      resolver(message);
      this._messageResolvers.delete(agentId);
      return;
    }

    // 如果没有专门解析器，查找通用等待解析器（以 wait_ 开头的）
    for (const [key, resolver] of this._messageResolvers) {
      if (key.startsWith('wait_')) {
        console.log(`[DEBUG:report] 触发通用 resolver: ${key}`);
        resolver(message);
        this._messageResolvers.delete(key);
        break;
      }
    }
  }

  /**
   * 等待任意子代理的消息
   * @returns { agentId, message }
   */
  async waitForMessage(): Promise<{ agentId: string; message: string }> {
    const timestamp = new Date().toISOString();
    console.log(`[DEBUG:waitForMessage] ${timestamp} 开始等待`);

    // 检查是否有待处理消息
    for (const [agentId, messages] of this._pendingMessages) {
      if (messages.length > 0) {
        const message = messages.shift()!;
        console.log(`[DEBUG:waitForMessage] ${timestamp} 从队列取出消息 agentId=${agentId}, 队列剩余: ${messages.length}`);
        if (messages.length === 0) {
          this._pendingMessages.delete(agentId);
        }
        return { agentId, message };
      }
    }

    console.log(`[DEBUG:waitForMessage] ${timestamp} 队列为空，注册 resolver`);

    // 等待新消息（无超时，一直等待直到有消息）
    return new Promise((resolve) => {
      // 临时存储解析器（任意子代理都可以触发）
      const tempKey = `wait_${Date.now()}`;
      console.log(`[DEBUG:waitForMessage] ${timestamp} 注册 resolver: ${tempKey}`);
      this._messageResolvers.set(tempKey, () => {
        const resolveTime = new Date().toISOString();
        console.log(`[DEBUG:waitForMessage.resolver] ${resolveTime} resolver 被触发`);
        // 查找发送消息的 agentId
        for (const [agentId, messages] of this._pendingMessages) {
          if (messages.length > 0) {
            const message = messages.shift()!;
            console.log(`[DEBUG:waitForMessage.resolver] ${resolveTime} 从队列取出消息 agentId=${agentId}, 队列剩余: ${messages.length}`);
            if (messages.length === 0) {
              this._pendingMessages.delete(agentId);
            }
            resolve({ agentId, message });
            return;
          }
        }
        console.log(`[DEBUG:waitForMessage.resolver] ${resolveTime} 队列为空！`);
      });
    });
  }

  /**
   * 检查是否有活跃的子代理或待处理的消息
   *
   * 注意：先检查消息队列，避免竞态条件
   */
  hasActiveAgents(): boolean {
    const timestamp = new Date().toISOString();
    // 优先检查消息队列
    for (const [agentId, messages] of this._pendingMessages.entries()) {
      if (messages.length > 0) {
        console.log(`[DEBUG:hasActiveAgents] ${timestamp} 发现消息队列: ${agentId}, ${messages.length} 条`);
        return true;
      }
    }
    // 再检查 busy 状态的子代理
    for (const instance of this._instances.values()) {
      if (instance.status === 'busy') {
        console.log(`[DEBUG:hasActiveAgents] ${timestamp} 发现 busy 子代理: ${instance.id}`);
        return true;
      }
    }
    console.log(`[DEBUG:hasActiveAgents] ${timestamp} 无活跃子代理`);
    return false;
  }

  /**
   * 检查是否有待处理的子代理消息
   */
  hasPendingMessages(): boolean {
    const timestamp = new Date().toISOString();
    for (const [agentId, messages] of this._pendingMessages.entries()) {
      if (messages.length > 0) {
        console.log(`[DEBUG:hasPendingMessages] ${timestamp} agentId=${agentId}, ${messages.length} 条消息`);
        return true;
      }
    }
    console.log(`[DEBUG:hasPendingMessages] ${timestamp} 无待处理消息`);
    return false;
  }

  /**
   * 消费所有待处理的子代理消息
   * @returns 消息列表
   */
  consumeAllPendingMessages(): Array<{agentId: string; message: string}> {
    const timestamp = new Date().toISOString();
    const results: Array<{agentId: string; message: string}> = [];
    for (const [agentId, messages] of this._pendingMessages.entries()) {
      console.log(`[DEBUG:consumeAllPendingMessages] ${timestamp} agentId=${agentId}, ${messages.length} 条消息`);
      for (const msg of messages) {
        results.push({ agentId, message: msg });
      }
    }
    this._pendingMessages.clear();
    console.log(`[DEBUG:consumeAllPendingMessages] ${timestamp} 总共消费 ${results.length} 条消息`);
    return results;
  }

  /**
   * 处理子代理中断
   * @param agentId 子代理 ID
   * @param reason 中断原因
   * @param result 中断时的结果
   */
  async handleInterrupt(
    agentId: string,
    reason: 'max_turns_reached' | 'error' | 'cancelled',
    result: string
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(`[DEBUG:handleInterrupt] ${timestamp} agentId=${agentId}, reason=${reason}, result="${result.slice(0, 50)}..."`);

    const instance = this._instances.get(agentId);
    if (!instance) return;

    const oldStatus = instance.status;
    instance.status = 'idle';
    instance.result = result;
    console.log(`[DEBUG:handleInterrupt] ${timestamp} 状态: ${oldStatus} -> idle`);

    // 报告消息（入队）
    await this.report(agentId, result);

    // 触发钩子
    await this._parent.onSubAgentInterrupt?.({
      agentId,
      type: instance.type,
      reason,
      result,
    });
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
    const timestamp = new Date().toISOString();
    console.log(`[DEBUG:_onComplete] ${timestamp} agentId=${id}, result="${result.slice(0, 50)}..."`);

    const instance = this._instances.get(id);
    if (!instance) return;

    const oldStatus = instance.status;

    // 先回传消息给主代理（确保消息先入队，避免竞态条件）
    await this.report(id, result);

    // 再更新状态（子代理持久存在，完成任务后回到 idle）
    instance.status = 'idle';
    instance.result = result;
    instance.completedAt = Date.now();

    console.log(`[DEBUG:_onComplete] ${timestamp} 状态: ${oldStatus} -> idle`);

    await this._parent.onSubAgentUpdate?.({
      agentId: id,
      type: instance.type,
      oldStatus,
      newStatus: 'idle',
      result,
    });
  }

  private async _onError(id: string, error: Error): Promise<void> {
    const instance = this._instances.get(id);
    if (!instance) return;

    const oldStatus = instance.status;

    // 先更新状态（错误情况不需要回传消息，因为父代理无法处理错误子代理的结果）
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
