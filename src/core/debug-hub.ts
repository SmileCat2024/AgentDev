/**
 * DebugHub - 全局多 Agent 调试中心
 *
 * 职责：
 * - 管理所有 Agent 的注册和注销
 * - 连接到独立的 Viewer Worker UDS 服务器
 * - 路由 Agent 消息到 Worker
 *
 * 设计原则：
 * - 单例模式，全局唯一
 * - 轻量：只做路由，不存储消息
 * - 直观：API 简单明了
 */

import { connect, Socket } from 'net';
import {
  getDefaultUDSPath,
  type Message,
  type Tool,
  type AgentInfo,
  type DebugHubIPCMessage,
  type Notification,
  type RequestInputMsg,
  type HookInspectorSnapshot,
  type UserInputRequest,
  type UserInputResponse,
} from './types.js';

// 前向声明 Agent 类型（避免循环依赖）
type Agent = any;

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
  private readonly processId: string;  // 进程唯一标识

  // 输入请求回调映射：requestId → resolver
  private pendingInputRequests = new Map<string, (response: UserInputResponse) => void>();

  // UDS 客户端连接
  private udsClient?: Socket;
  private udsPath: string;
  private workerPort: number | null = null;
  private clientReady: boolean = false;

  // 注册锁（防止并发竞争）
  private registrationLock: boolean = false;

  // 待发送的消息队列（连接建立前）
  private messageQueue: DebugHubIPCMessage[] = [];

  // ========== 单例 ==========
  private constructor() {
    this.udsPath = process.env.AGENTDEV_UDS_PATH || getDefaultUDSPath();
    // 使用进程 PID 作为唯一标识，确保多进程环境下 Agent ID 不冲突
    this.processId = String(process.pid);
  }

  static getInstance(): DebugHub {
    if (!DebugHub.instance) {
      DebugHub.instance = new DebugHub();
    }
    return DebugHub.instance;
  }

  // ========== 公开 API ==========

  /**
   * 启动调试服务器
   * @param port HTTP 端口（默认 2026，仅用于显示）
   * @param openBrowser 是否自动打开浏览器（默认 true，已废弃参数）
   */
  async start(port: number = 2026, openBrowser: boolean = true): Promise<void> {
    if (this.udsClient) {
      console.log(`[DebugHub] 已连接到 ViewerWorker`);
      return;
    }

    this.workerPort = port;  // 保留用于信息显示
    try {
      await this.connectToWorker();
      console.log(`[DebugHub] 调试服务器已连接: http://localhost:${port}`);
    } catch (err) {
      // 连接失败只警告，不抛出异常
      console.warn(`[DebugHub] 无法连接到 ViewerWorker: ${(err as Error).message}`);
      console.warn(`[DebugHub] 调试功能将被禁用。请先启动 ViewerWorker 服务器。`);
      this.clientReady = false;
    }
  }

  /**
   * 停止调试服务器
   */
  stop(): void {
    if (this.udsClient) {
      this.sendToWorker({ type: 'stop' });
      this.udsClient.end();
      this.udsClient = undefined;
      this.clientReady = false;
    }
  }

  /**
   * 注册 Agent
   * @param agent Agent 实例
   * @param name 显示名称（可选，默认使用类名）
   * @param featureTemplates Feature 模板路径映射（可选）
   * @returns 分配的 agentId
   */
  registerAgent(
    agent: Agent,
    name?: string,
    featureTemplates?: Record<string, string>,
    hookInspector?: HookInspectorSnapshot
  ): string {
    // 等待注册锁
    while (this.registrationLock) {
      // 简单的忙等待（实际场景中竞争很少）
    }
    this.registrationLock = true;

    try {
      const id = `agent-${this.nextId++}-${this.processId}`;
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
        projectRoot: process.cwd(), // 传递项目根目录，用于模板文件加载
        featureTemplates, // 传递 Feature 模板路径映射
        hookInspector,
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

  updateAgentInspector(agentId: string, hookInspector: HookInspectorSnapshot): void {
    this.sendToWorker({
      type: 'update-agent-inspector',
      agentId,
      hookInspector,
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

  /**
   * 检查是否已连接到 ViewerWorker
   */
  isConnected(): boolean {
    return this.clientReady && !!this.udsClient;
  }

  /**
   * 推送通知
   * @param agentId Agent ID
   * @param notification 通知对象
   */
  pushNotification(agentId: string, notification: Notification): void {
    this.sendToWorker({
      type: 'push-notification',
      agentId,
      notification,
    });
  }

  /**
   * 请求用户输入
   * @param agentId Agent ID
   * @param prompt 提示信息
   * @param timeout 超时时间（毫秒），默认 Infinity（无限等待）
   * @returns Promise<string> 用户输入内容
   */
  requestUserInput(agentId: string, prompt: string, timeout: number = Infinity): Promise<string> {
    return this.requestUserInputEvent(agentId, { prompt }, timeout).then((response) => {
      if (response.kind !== 'text') {
        throw new Error(`Expected text user input but received action '${response.actionId ?? 'unknown'}'`);
      }
      return response.text ?? '';
    });
  }

  requestUserInputEvent(
    agentId: string,
    request: UserInputRequest,
    timeout: number = Infinity,
  ): Promise<UserInputResponse> {
    const requestId = `input-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      // 设置超时定时器（仅在 timeout 为有限数值时）
      let timer: NodeJS.Timeout | undefined;
      if (timeout !== Infinity) {
        timer = setTimeout(() => {
          this.pendingInputRequests.delete(requestId);
          reject(new Error(`User input timeout after ${timeout}ms`));
        }, timeout);
      }

      // 存储 resolve 函数
      this.pendingInputRequests.set(requestId, (response: UserInputResponse) => {
        if (timer) clearTimeout(timer);
        resolve(response);
      });

      // 发送请求到 ViewerWorker
      this.sendToWorker({
        type: 'request-input',
        agentId,
        requestId,
        prompt: request.prompt,
        placeholder: request.placeholder,
        initialValue: request.initialValue,
        actions: request.actions,
        timeout,
      } as RequestInputMsg);
    });
  }

  // ========== 内部方法 ==========

  /**
   * 连接到 UDS 服务器
   */
  private async connectToWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.udsClient = connect(this.udsPath);

      this.udsClient.on('connect', () => {
        this.clientReady = true;
        console.log(`[DebugHub] 已连接到 ViewerWorker: ${this.udsPath}`);

        // 发送队列中的消息
        for (const msg of this.messageQueue) {
          this.sendViaUDS(msg);
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
      });

      this.udsClient.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleWorkerMessage(msg);
          } catch (err) {
            console.error('[DebugHub] Worker 消息解析失败:', err);
          }
        }
      });

      this.udsClient.on('error', (err: Error) => {
        reject(new Error(`连接 ViewerWorker 失败 (${this.udsPath}): ${err.message}\n请先启动 ViewerWorker 服务器`));
      });

      this.udsClient.on('close', () => {
        this.clientReady = false;
        console.warn('[DebugHub] 与 ViewerWorker 的连接已断开');
      });
    });
  }

  /**
   * 处理来自 Worker 的消息
   */
  private handleWorkerMessage(msg: any): void {
    switch (msg.type) {
      case 'agent-switched':
        console.log(`[DebugHub] 当前 Agent 已切换: ${msg.agentId}`);
        break;

      // 处理用户输入响应
      case 'input-response':
        const resolver = this.pendingInputRequests.get(msg.requestId);
        if (resolver) {
          resolver(msg.response ?? {
            kind: 'text',
            text: msg.input,
          });
          this.pendingInputRequests.delete(msg.requestId);
        } else {
          console.warn(`[DebugHub] 未知输入响应: ${msg.requestId}`);
        }
        break;
    }
  }

  /**
   * 通过 UDS 发送消息
   */
  private sendViaUDS(msg: DebugHubIPCMessage): void {
    if (this.udsClient && this.clientReady) {
      this.udsClient.write(JSON.stringify(msg) + '\n');
    }
    // 未连接时丢弃消息，不再队列（避免内存泄漏）
  }

  /**
   * 发送消息到 Worker
   */
  private sendToWorker(msg: DebugHubIPCMessage): void {
    if (!this.udsClient) {
      return;
    }
    this.sendViaUDS(msg);
  }
}
