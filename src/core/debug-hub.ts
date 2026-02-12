/**
 * DebugHub - 全局多 Agent 调试中心
 *
 * 职责：
 * - 管理所有 Agent 的注册和注销
 * - 维护共享的 Viewer Worker 进程
 * - 路由 Agent 消息到 Worker
 *
 * 设计原则：
 * - 单例模式，全局唯一
 * - 轻量：只做路由，不存储消息
 * - 直观：API 简单明了
 */

import { fork, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type {
  Message,
  Tool,
  AgentInfo,
  DebugHubIPCMessage,
} from './types.js';

// 前向声明 Agent 类型（避免循环依赖）
type Agent = any;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Hub 内部存储的 Agent 数据
 */
interface AgentData {
  info: AgentInfo;
  agent: Agent;
}

export class DebugHub {
  private static instance: DebugHub;

  // ========== 状态 ==========
  private agents: Map<string, AgentData> = new Map();
  private currentAgentId: string | null = null;
  private nextId: number = 1;

  // Worker 进程
  private worker: ChildProcess | null = null;
  private workerPort: number | null = null;
  private workerReady: boolean = false;

  // 注册锁（防止并发竞争）
  private registrationLock: boolean = false;

  // 待发送的消息队列（Worker 启动前）
  private messageQueue: DebugHubIPCMessage[] = [];

  // ========== 单例 ==========
  private constructor() {}

  static getInstance(): DebugHub {
    if (!DebugHub.instance) {
      DebugHub.instance = new DebugHub();
    }
    return DebugHub.instance;
  }

  // ========== 公开 API ==========

  /**
   * 启动调试服务器
   * @param port HTTP 端口（默认 2026）
   */
  async start(port: number = 2026): Promise<void> {
    if (this.worker) {
      console.log(`[DebugHub] 调试服务器已在端口 ${this.workerPort} 运行`);
      return;
    }

    this.workerPort = port;
    await this.startWorker();
    console.log(`[DebugHub] 调试服务器已启动: http://localhost:${port}`);
  }

  /**
   * 停止调试服务器
   */
  stop(): void {
    if (this.worker) {
      this.sendToWorker({ type: 'stop' });
      this.worker = null;
      this.workerReady = false;
    }
  }

  /**
   * 注册 Agent
   * @param agent Agent 实例
   * @param name 显示名称（可选，默认使用类名）
   * @returns 分配的 agentId
   */
  registerAgent(agent: Agent, name?: string): string {
    // 等待注册锁
    while (this.registrationLock) {
      // 简单的忙等待（实际场景中竞争很少）
    }
    this.registrationLock = true;

    try {
      const id = `agent-${this.nextId++}`;
      const info: AgentInfo = {
        id,
        name: name || agent.constructor.name,
        registeredAt: Date.now(),
      };

      this.agents.set(id, { info, agent });

      // 首个注册的 Agent 自动成为当前 Agent
      if (this.agents.size === 1) {
        this.currentAgentId = id;
      }

      // 通知 Worker
      this.sendToWorker({
        type: 'register-agent',
        agentId: id,
        name: info.name,
        createdAt: info.registeredAt,
      });

      console.log(`[DebugHub] Agent 已注册: ${id} (${info.name})`);
      return id;
    } finally {
      this.registrationLock = false;
    }
  }

  /**
   * 注销 Agent
   * @param agentId Agent ID
   */
  unregisterAgent(agentId: string): void {
    const deleted = this.agents.delete(agentId);
    if (deleted) {
      this.sendToWorker({ type: 'unregister-agent', agentId });
      console.log(`[DebugHub] Agent 已注销: ${agentId}`);

      // 如果注销的是当前 Agent，切换到另一个
      if (this.currentAgentId === agentId) {
        const remaining = Array.from(this.agents.keys());
        this.currentAgentId = remaining.length > 0 ? remaining[0] : null;
        if (this.currentAgentId) {
          this.sendToWorker({
            type: 'set-current-agent',
            agentId: this.currentAgentId,
          });
        }
      }
    }
  }

  /**
   * 切换当前选中的 Agent
   * @param agentId Agent ID
   * @returns 是否成功
   */
  selectAgent(agentId: string): boolean {
    if (!this.agents.has(agentId)) {
      return false;
    }
    this.currentAgentId = agentId;
    this.sendToWorker({
      type: 'set-current-agent',
      agentId,
    });
    console.log(`[DebugHub] 当前 Agent 已切换: ${agentId}`);
    return true;
  }

  /**
   * 推送 Agent 消息
   * @param agentId Agent ID
   * @param messages 消息数组
   */
  pushMessages(agentId: string, messages: Message[]): void {
    this.sendToWorker({
      type: 'push-messages',
      agentId,
      messages,
    });
  }

  /**
   * 注册 Agent 工具
   * @param agentId Agent ID
   * @param tools 工具数组
   */
  registerAgentTools(agentId: string, tools: Tool[]): void {
    this.sendToWorker({
      type: 'register-tools',
      agentId,
      tools,
    });
  }

  /**
   * 获取所有已注册的 Agent 信息
   */
  getAgentList(): AgentInfo[] {
    return Array.from(this.agents.values()).map(v => v.info);
  }

  /**
   * 获取当前选中的 Agent ID
   */
  getCurrentAgentId(): string | null {
    return this.currentAgentId;
  }

  /**
   * 根据 Agent 实例获取其 ID
   */
  getAgentId(agent: Agent): string | undefined {
    for (const [id, data] of this.agents) {
      if (data.agent === agent) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * 获取 Worker 端口
   */
  getPort(): number | null {
    return this.workerPort;
  }

  // ========== 内部方法 ==========

  /**
   * 启动 Worker 进程
   */
  private async startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const workerPath = join(__dirname, 'viewer-worker.js');

      this.worker = fork(workerPath, [String(this.workerPort)], {
        silent: false,
      });

      // 等待 Worker 就绪
      const onReady = (msg: any) => {
        if (msg.type === 'ready') {
          this.workerReady = true;
          this.worker?.off('message', onReady);

          // 发送队列中的消息
          for (const queuedMsg of this.messageQueue) {
            this.worker!.send(queuedMsg);
          }
          this.messageQueue = [];

          // 设置当前 Agent
          if (this.currentAgentId) {
            this.sendToWorker({
              type: 'set-current-agent',
              agentId: this.currentAgentId,
            });
          }

          resolve();
        }
      };

      this.worker.on('message', onReady);

      // 错误处理
      this.worker.on('error', (err: Error) => {
        reject(new Error(`Worker 启动失败: ${err.message}`));
      });

      // 崩溃恢复
      this.worker.on('exit', (code: number) => {
        if (code !== 0 && this.worker) {
          console.warn('[DebugHub] Worker 崩溃，正在重启...');
          this.workerReady = false;
          setTimeout(() => {
            this.startWorker().catch(err => {
              console.error('[DebugHub] Worker 重启失败:', err);
            });
          }, 1000);
        }
      });
    });
  }

  /**
   * 发送消息到 Worker
   */
  private sendToWorker(msg: DebugHubIPCMessage): void {
    if (!this.worker) {
      return;
    }

    if (this.workerReady) {
      this.worker.send(msg);
    } else {
      // Worker 未就绪，加入队列
      this.messageQueue.push(msg);
    }
  }
}
