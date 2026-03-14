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
  type AgentOverviewSnapshot,
  type UserInputRequest,
  type UserInputResponse,
  type UserInputAction,
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

  // 活跃的输入请求元数据（用于重连恢复）：agentId → requestInfo
  private activeInputRequests = new Map<string, {
    requestId: string;
    prompt: string;
    placeholder?: string;
    initialValue?: string;
    actions?: UserInputAction[];
    timestamp: number;
  }>();

  // UDS 客户端连接
  private udsClient?: Socket;
  private udsPath: string;
  private workerPort: number | null = null;
  private clientReady: boolean = false;

  // 注册锁（防止并发竞争）
  private registrationLock: boolean = false;

  // 待发送的消息队列（连接建立前）
  private messageQueue: DebugHubIPCMessage[] = [];

  // 重连机制
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_DELAY = 2000;

  // 缓存每个 Agent 的 featureTemplates（用于重连后重新注册）
  private agentFeatureTemplates: Map<string, Record<string, string>> = new Map();

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
    // 停止重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.udsClient) {
      this.sendToWorker({ type: 'stop' });
      this.udsClient.end();
      this.udsClient = undefined;
      this.clientReady = false;
    }
  }

  /**
   * 手动重连（可选）
   * 如果已经连接，则不执行任何操作
   */
  async reconnect(): Promise<void> {
    if (this.clientReady && this.udsClient) {
      console.log('[DebugHub] 已经连接，无需重连');
      return;
    }

    // 重置重连状态
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    try {
      await this.connectToWorker();
      console.log('[DebugHub] ✅ 手动重连成功');
    } catch (error) {
      console.error(`[DebugHub] 手动重连失败: ${(error as Error).message}`);
      throw error;
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
    hookInspector?: HookInspectorSnapshot,
    overview?: AgentOverviewSnapshot
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

      // 缓存 featureTemplates（用于重连后重新注册）
      if (featureTemplates) {
        this.agentFeatureTemplates.set(id, featureTemplates);
      }

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
        overview,
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

  updateAgentOverview(agentId: string, overview: AgentOverviewSnapshot): void {
    this.sendToWorker({
      type: 'update-agent-overview',
      agentId,
      overview,
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
          this.activeInputRequests.delete(agentId); // 清除活跃请求记录
          reject(new Error(`User input timeout after ${timeout}ms`));
        }, timeout);
      }

      // 存储 resolve 函数
      this.pendingInputRequests.set(requestId, (response: UserInputResponse) => {
        if (timer) clearTimeout(timer);
        this.activeInputRequests.delete(agentId); // 清除活跃请求记录
        resolve(response);
      });

      // 记录活跃请求（用于重连恢复）
      this.activeInputRequests.set(agentId, {
        requestId,
        prompt: request.prompt,
        placeholder: request.placeholder,
        initialValue: request.initialValue,
        actions: request.actions,
        timestamp: Date.now(),
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
        this.reconnectAttempts = 0; // 重置重连计数
        console.log(`[DebugHub] 已连接到 ViewerWorker: ${this.udsPath}`);

        // 发送队列中的消息
        for (const msg of this.messageQueue) {
          this.sendViaUDS(msg);
        }
        this.messageQueue = [];

        // 关键：重新注册所有 Agent（用于重连后恢复状态）
        this.reregisterAllAgents();

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

        // 自动重连
        this.scheduleReconnect();
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
   * 重新注册所有 Agent（重连后调用）
   * 确保 ViewerWorker 能够恢复所有 Agent 的注册信息
   */
  private reregisterAllAgents(): void {
    if (this.agents.size === 0) {
      return;
    }

    console.log(`[DebugHub] 重新注册 ${this.agents.size} 个 Agent...`);

    for (const [id, data] of this.agents) {
      // 获取最新的 hookInspector
      const hookInspector = (data.agent as any).buildHookInspectorSnapshot?.()
        || (data.agent as any).hookInspector;
      const overview = (data.agent as any).buildOverviewSnapshot?.();

      // 获取缓存的 featureTemplates
      const featureTemplates = this.agentFeatureTemplates.get(id) || {};

      // 获取活跃的输入请求（用于恢复输入框）
      const activeInputRequest = this.activeInputRequests.get(id);
      if (activeInputRequest) {
        console.log(`[DebugHub] 发现活跃输入请求: ${activeInputRequest.requestId}`);
      }

      this.sendToWorker({
        type: 'register-agent' as const,
        agentId: id,
        name: data.info.name,
        createdAt: data.info.registeredAt,
        projectRoot: process.cwd(),
        featureTemplates,
        hookInspector,
        overview,
        activeInputRequest, // 携带活跃输入请求
      });

      // 重新注册工具（如果有）
      const tools = (data.agent as any).tools;
      if (tools && typeof tools.getEntries === 'function') {
        const entries = tools.getEntries();
        const toolList = entries.map((e: any) => e.tool);
        if (toolList.length > 0) {
          this.sendToWorker({
            type: 'register-tools',
            agentId: id,
            tools: toolList,
          });
        }
      }

      // 重新发送对话记录（用于重连后恢复消息历史）
      const context = (data.agent as any).getContext?.();
      if (context && typeof context.getAll === 'function') {
        const messages = context.getAll();
        if (messages.length > 0) {
          this.sendToWorker({
            type: 'push-messages',
            agentId: id,
            messages,
          });
          console.log(`[DebugHub] 恢复 Agent ${id} 的 ${messages.length} 条消息`);
        }
      }
    }

    console.log(`[DebugHub] ✅ 重新注册完成`);
  }

  /**
   * 安排重连（指数退避）
   */
  private scheduleReconnect(): void {
    // 清除现有的定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // 检查是否达到最大重连次数
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[DebugHub] 达到最大重连次数 (${this.MAX_RECONNECT_ATTEMPTS})，停止重连`);
      return;
    }

    this.reconnectAttempts++;

    // 计算延迟时间（指数退避，最大 30 秒）
    const delay = Math.min(
      this.RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      30000
    );

    console.log(`[DebugHub] ${delay}ms 后尝试第 ${this.reconnectAttempts} 次重连...`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectToWorker();
        console.log('[DebugHub] ✅ 重连成功，调试功能已恢复');
      } catch (error) {
        console.error(`[DebugHub] 重连失败: ${(error as Error).message}`);
        // 继续尝试重连
        this.scheduleReconnect();
      }
    }, delay);
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
