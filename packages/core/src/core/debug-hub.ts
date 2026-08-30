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

import { connect, type Socket } from 'net';
import type { ChildProcess } from 'child_process';
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
  type TodoPlanSnapshot,
  type UserInputRequest,
  type UserInputResponse,
  type UserInputAction,
} from './types.js';
import { ClawDebugClient } from './claw-debug-client.js';
import { getClawRuntimeUrl, resolveDebugTransportMode } from './debug-transport.js';
import { getDebugCapabilities, type DebugCapabilities } from './debug-capabilities.js';

// 前向声明 Agent 类型（避免循环依赖）
type Agent = any;

/**
 * Hub 内部存储的 Agent 数据
 */
interface AgentData {
  info: AgentInfo;
  agent: Agent;
}

interface PendingInputRequest {
  agentId: string;
  resolve: (response: UserInputResponse) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  abortController?: AbortController;
}

export class DebugHub {
  private static instance: DebugHub;
  private readonly transportMode: 'viewer-worker' | 'claw';
  private readonly clawClient?: ClawDebugClient;

  // ========== 状态 ==========
  private agents: Map<string, AgentData> = new Map();
  private nextId: number = 1;
  private readonly processId: string;  // 进程唯一标识

  // 输入请求回调映射：requestId → owned request lifecycle
  private pendingInputRequests = new Map<string, PendingInputRequest>();
  private interruptHandlers = new Map<string, (agentId: string, clearQueue: boolean) => void | Promise<void>>();
  private globalInterruptHandler?: (agentId: string, clearQueue: boolean) => void | Promise<void>;

  // 活跃的输入请求元数据（用于重连恢复）：agentId → requestInfo
  private activeInputRequests = new Map<string, {
    requestId: string;
    prompt: string;
    placeholder?: string;
    initialValue?: string;
    actions?: UserInputAction[];
    mode?: UserInputRequest['mode'];
    questions?: UserInputRequest['questions'];
    timestamp: number;
  }>();

  // UDS 客户端连接
  private udsClient?: Socket;
  private udsPath: string;
  private workerReadBuffer: string = '';
  private workerPort: number | null = null;
  private clientReady: boolean = false;
  private stopped: boolean = false;
  /** Shared connection barrier for every Agent hosted by this process. */
  private connectionPromise?: Promise<void>;
  /** headless 运行时（无 ViewerWorker）下每类消息只告警一次，避免刷屏。 */
  private sendToWorkerWarnedTypes: Set<string> = new Set();

  // 注册锁（防止并发竞争）
  private registrationLock: boolean = false;

  // 重连机制
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_DELAY = 2000;

  // 缓存每个 Agent 的模板装载载荷（mounts + entries，用于重连后重新注册）
  private agentTemplatePayload: Map<string, { mounts: string[]; entries: Record<string, { mount: number; rel: string }> }> = new Map();

  // 缓存每个 Agent 的外部输入策略（用于重连后重新注册）
  private agentInputPolicy: Map<string, 'standard' | 'none'> = new Map();

  // ========== 单例 ==========
  private constructor() {
    this.udsPath = process.env.AGENTDEV_UDS_PATH || getDefaultUDSPath();
    // 使用进程 PID 作为唯一标识，确保多进程环境下 Agent ID 不冲突
    this.processId = String(process.pid);
    this.transportMode = resolveDebugTransportMode();
    if (this.transportMode === 'claw') {
      this.clawClient = new ClawDebugClient({
        processId: this.processId,
        projectRoot: process.cwd(),
      });
    }
  }

  static getInstance(): DebugHub {
    if (!DebugHub.instance) {
      DebugHub.instance = new DebugHub();
    }
    return DebugHub.instance;
  }

  /**
   * 为 Agent 分配进程内稳定且唯一的运行时 ID。
   * 分配不等于注册；同一 ID 可在后续 Viewer attach/re-attach 时复用。
   */
  allocateAgentId(): string {
    return `agent-${this.nextId++}-${this.processId}`;
  }

  // ========== 公开 API ==========

  /**
   * 启动调试服务器
   * @param port HTTP 端口（默认 2026，仅用于显示）
   * @param openBrowser 是否自动打开浏览器（默认 true，已废弃参数）
   */
  async start(port: number = 2026, openBrowser: boolean = true): Promise<void> {
    if (this.clientReady) return;
    if (this.connectionPromise) return this.connectionPromise;

    const pending = this.startInternal(port, openBrowser);
    this.connectionPromise = pending;
    try {
      await pending;
    } finally {
      if (this.connectionPromise === pending) {
        this.connectionPromise = undefined;
      }
    }
  }

  private async startInternal(port: number, openBrowser: boolean): Promise<void> {
    this.stopped = false;
    if (this.transportMode === 'claw') {
      this.workerPort = port;
      try {
        await this.clawClient?.ping();
        this.clientReady = true;
        console.log(`[DebugHub] 已连接到 Claw runtime: ${getClawRuntimeUrl()}`);
      } catch (err) {
        console.warn(`[DebugHub] 无法连接到 Claw runtime: ${(err as Error).message}`);
        console.warn('[DebugHub] 调试功能将被禁用。请先启动 AgentDevClaw runtime。');
        this.clientReady = false;
        throw err;
      }
      return;
    }

    this.workerPort = port;  // 保留用于信息显示
    this.openBrowser = openBrowser;  // 保存浏览器打开设置
    
    try {
      await this.connectToWorker();
      console.log(`[DebugHub] 调试服务器已连接: http://localhost:${port}`);
    } catch {
      // 连接失败，尝试自动启动 ViewerWorker
      console.log(`[DebugHub] ViewerWorker 未运行，正在自动启动...`);
      try {
        await this.spawnViewerWorker();
        // 等待服务器启动
        await new Promise(resolve => setTimeout(resolve, 1000));
        // 再次尝试连接
        await this.connectToWorker();
        console.log(`[DebugHub] 调试服务器已连接: http://localhost:${port}`);
      } catch (spawnErr) {
        console.warn(`[DebugHub] 无法启动 ViewerWorker: ${(spawnErr as Error).message}`);
        console.warn(`[DebugHub] 调试功能将被禁用。请手动运行 'agentdev-viewer' 启动调试服务器。`);
        this.clientReady = false;
        // A Viewer-backed Agent cannot safely continue without its transport:
        // registration/input messages would otherwise be silently discarded.
        throw spawnErr;
      }
    }
  }

  /**
   * 自动启动 ViewerWorker 进程
   */
  private openBrowser: boolean = true;
  private viewerWorkerProcess?: ChildProcess;

  private async spawnViewerWorker(): Promise<void> {
    const { spawn } = await import('child_process');
    const { existsSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');

    // 查找 viewer.js 的路径
    let viewerPath: string;

    // 方式1: 优先使用 require.resolve（最可靠）
    try {
      const agentdevPath = require.resolve('agentdev/package.json');
      viewerPath = join(dirname(agentdevPath), 'dist', 'cli', 'viewer.js');
    } catch {
      // 方式2: 从当前模块解析
      try {
        const currentDir = dirname(fileURLToPath(import.meta.url));
        viewerPath = join(currentDir, '..', 'cli', 'viewer.js');
      } catch {
        // 方式3: 使用 bin 命令
        viewerPath = 'agentdev-viewer';
      }
    }

    // 验证文件存在
    if (viewerPath !== 'agentdev-viewer' && !existsSync(viewerPath)) {
      // 回退到 bin 命令
      viewerPath = 'agentdev-viewer';
    }

    return new Promise((resolve, reject) => {
      try {
        // 设置环境变量
        const env = {
          ...process.env,
          AGENTDEV_PORT: String(this.workerPort || 2026),
          AGENTDEV_OPEN_BROWSER: this.openBrowser ? 'true' : 'false',
          AGENTDEV_UDS_PATH: this.udsPath,
        };

        console.log(`[DebugHub] 启动 ViewerWorker: ${viewerPath}`);

        // 如果是 bin 命令，直接运行命令；否则用 node 执行
        const isBinCommand = viewerPath === 'agentdev-viewer' || viewerPath === 'agentdev-server';
        const command = isBinCommand ? viewerPath : 'node';
        const args = isBinCommand ? [] : [viewerPath];

        this.viewerWorkerProcess = spawn(command, args, {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          shell: isBinCommand, // bin 命令需要 shell 来解析
        });

        this.viewerWorkerProcess.on('error', (err: Error) => {
          console.error('[DebugHub] ViewerWorker 进程错误:', err.message);
          reject(err);
        });

        // 输出 ViewerWorker 的日志
        this.viewerWorkerProcess.stdout?.on('data', (data: Buffer) => {
          const lines = data.toString().trim().split('\n');
          for (const line of lines) {
            console.log(`[ViewerWorker] ${line}`);
          }
        });

        this.viewerWorkerProcess.stderr?.on('data', (data: Buffer) => {
          const lines = data.toString().trim().split('\n');
          for (const line of lines) {
            console.error(`[ViewerWorker] ${line}`);
          }
        });

        // 给进程一点时间启动
        setTimeout(() => {
          if (this.viewerWorkerProcess && !this.viewerWorkerProcess.killed) {
            resolve();
          } else {
            reject(new Error('ViewerWorker 进程启动失败'));
          }
        }, 500);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 停止调试服务器
   */
  stop(): void {
    this.stopped = true;
    if (this.transportMode === 'claw') {
      this.clientReady = false;
      return;
    }

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
    if (this.transportMode === 'claw') {
      await this.start(this.workerPort ?? 2026, false);
      if (!this.clientReady) {
        throw new Error('Claw runtime reconnect failed');
      }
      return;
    }

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
   * @param templateMounts 模板装载点（真实目录根，可选）
   * @param templateEntries 模板名 → {mount 下标, rel 相对路径}（可选）
   * @returns 分配的 agentId
   */
  registerAgent(
    agent: Agent,
    name?: string,
    templateMounts?: string[],
    templateEntries?: Record<string, { mount: number; rel: string }>,
    hookInspector?: HookInspectorSnapshot,
    overview?: AgentOverviewSnapshot,
    projectRoot?: string,
    reservedAgentId?: string,
    inputPolicy?: 'standard' | 'none',
  ): string {
    // 等待注册锁
    while (this.registrationLock) {
      // 简单的忙等待（实际场景中竞争很少）
    }
    this.registrationLock = true;

    try {
      const resolvedProjectRoot = projectRoot || process.cwd();
      const id = reservedAgentId || this.allocateAgentId();
      const existing = this.agents.get(id);
      if (existing && existing.agent !== agent) {
        throw new Error(`Agent ID '${id}' is already registered by another Agent instance`);
      }
      const info: AgentInfo = {
        id,
        name: name || agent.constructor.name,
        registeredAt: existing?.info.registeredAt ?? Date.now(),
        projectRoot: resolvedProjectRoot,
      };

      this.agents.set(id, { info, agent });

      // 缓存模板装载载荷（用于重连后重新注册）
      if (templateMounts || templateEntries) {
        this.agentTemplatePayload.set(id, {
          mounts: templateMounts ?? [],
          entries: templateEntries ?? {},
        });
      }

      // 缓存外部输入策略（用于重连后重新注册）
      if (inputPolicy) {
        this.agentInputPolicy.set(id, inputPolicy);
      }

      // 通知 Worker
      if (this.transportMode === 'claw') {
        void this.clawClient?.registerAgent({
          agentId: id,
          name: info.name,
          projectRoot: resolvedProjectRoot,
          templateMounts: templateMounts ?? [],
          templateEntries: templateEntries ?? {},
          hookInspector,
          overview,
          inputPolicy: inputPolicy || undefined,
        }).catch(error => {
          console.error(`[DebugHub] Claw registerAgent 失败: ${(error as Error).message}`);
        });
      } else {
        this.sendToWorker({
          type: 'register-agent',
          agentId: id,
          name: info.name,
          createdAt: info.registeredAt,
          projectRoot: resolvedProjectRoot,
          templateMounts: templateMounts ?? [],
          templateEntries: templateEntries ?? {},
          hookInspector,
          overview,
          inputPolicy: inputPolicy || undefined,
        });
      }

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
    this.interruptHandlers.delete(agentId);
    this.cancelInputRequests(agentId, `Agent '${agentId}' was unregistered`);
    this.activeInputRequests.delete(agentId);

    const deleted = this.agents.delete(agentId);
    if (deleted) {
      this.agentTemplatePayload.delete(agentId);
      this.agentInputPolicy.delete(agentId);
      if (this.transportMode === 'claw') {
        void this.clawClient?.unregisterAgent(agentId).catch(error => {
          console.error(`[DebugHub] Claw unregisterAgent 失败: ${(error as Error).message}`);
        });
      } else {
        this.sendToWorker({ type: 'unregister-agent', agentId });
      }
      console.log(`[DebugHub] Agent 已注销: ${agentId}`);
    }
  }

  /**
   * 推送 Agent 消息
   * @param agentId Agent ID
   * @param messages 消息数组
   */
  pushMessages(agentId: string, messages: Message[]): void {
    if (this.transportMode === 'claw') {
      void this.clawClient?.pushMessages(agentId, messages).catch(error => {
        console.error(`[DebugHub] Claw pushMessages 失败: ${(error as Error).message}`);
      });
      return;
    }

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
    if (this.transportMode === 'claw') {
      void this.clawClient?.registerTools(agentId, tools).catch(error => {
        console.error(`[DebugHub] Claw registerTools 失败: ${(error as Error).message}`);
      });
      return;
    }

    this.sendToWorker({
      type: 'register-tools',
      agentId,
      tools,
    });
  }

  updateAgentInspector(agentId: string, hookInspector: HookInspectorSnapshot): void {
    if (this.transportMode === 'claw') {
      void this.clawClient?.updateInspector(agentId, hookInspector).catch(error => {
        console.error(`[DebugHub] Claw updateInspector 失败: ${(error as Error).message}`);
      });
      return;
    }

    this.sendToWorker({
      type: 'update-agent-inspector',
      agentId,
      hookInspector,
    });
  }

  updateAgentOverview(agentId: string, overview: AgentOverviewSnapshot): void {
    if (this.transportMode === 'claw') {
      void this.clawClient?.updateOverview(agentId, overview).catch(error => {
        console.error(`[DebugHub] Claw updateOverview 失败: ${(error as Error).message}`);
      });
      return;
    }

    this.sendToWorker({
      type: 'update-agent-overview',
      agentId,
      overview,
    });
  }

  updateTodoPlan(agentId: string, plan: TodoPlanSnapshot): void {
    if (this.transportMode === 'claw') {
      void this.clawClient?.updateTodoPlan(agentId, plan).catch(error => {
        console.error(`[DebugHub] Claw updateTodoPlan 失败: ${(error as Error).message}`);
      });
      return;
    }

    this.sendToWorker({
      type: 'update-todo-plan',
      agentId,
      plan,
    } as DebugHubIPCMessage);
  }

  /**
   * 获取所有已注册的 Agent 信息
   */
  getAgentList(): AgentInfo[] {
    return Array.from(this.agents.values()).map(v => v.info);
  }

  isAgentRegistered(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  getTransportMode(): 'viewer-worker' | 'claw' {
    return this.transportMode;
  }

  getCapabilities(): DebugCapabilities {
    return getDebugCapabilities();
  }

  setInterruptHandler(
    agentIdOrHandler: string | ((agentId: string, clearQueue: boolean) => void | Promise<void>) | undefined,
    handler?: (agentId: string, clearQueue: boolean) => void | Promise<void>,
  ): () => void {
    if (typeof agentIdOrHandler === 'string') {
      // per-agent 注册
      if (handler) {
        this.interruptHandlers.set(agentIdOrHandler, handler);
        return () => {
          if (this.interruptHandlers.get(agentIdOrHandler) === handler) {
            this.interruptHandlers.delete(agentIdOrHandler);
          }
        };
      } else {
        this.interruptHandlers.delete(agentIdOrHandler);
        return () => {};
      }
    } else {
      // 旧式全局 fallback
      this.globalInterruptHandler = agentIdOrHandler;
      return () => {
        if (this.globalInterruptHandler === agentIdOrHandler) {
          this.globalInterruptHandler = undefined;
        }
      };
    }
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
    if (this.transportMode === 'claw') {
      return this.clientReady;
    }
    return this.clientReady && !!this.udsClient;
  }

  /**
   * 推送通知
   * @param agentId Agent ID
   * @param notification 通知对象
   */
  pushNotification(agentId: string, notification: Notification): void {
    if (this.transportMode === 'claw') {
      void this.clawClient?.pushNotification(agentId, notification).catch(error => {
        console.error(`[DebugHub] Claw pushNotification 失败: ${(error as Error).message}`);
      });
      return;
    }

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
    // 输入是每个 Agent 的单一租约，不允许多个 Promise 同时争抢下一次回复。
    if (this.activeInputRequests.has(agentId)) {
      return Promise.reject(new Error(`Agent '${agentId}' already has an active user input lease`));
    }

    if (this.transportMode === 'claw') {
      if (!this.clawClient) {
        return Promise.reject(new Error('Claw client is not available'));
      }
      const localRequestId = `claw-input-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const abortController = new AbortController();
      return new Promise((resolve, reject) => {
        this.pendingInputRequests.set(localRequestId, {
          agentId,
          resolve,
          reject,
          abortController,
        });
        this.activeInputRequests.set(agentId, {
          requestId: localRequestId,
          prompt: request.prompt,
          placeholder: request.placeholder,
          initialValue: request.initialValue,
          actions: request.actions,
          mode: request.mode,
          questions: request.questions,
          timestamp: Date.now(),
        });
        this.clawClient!.requestUserInput(agentId, request, timeout, abortController.signal)
          .then(response => this.settleInputRequest(localRequestId, { response }))
          .catch(error => this.settleInputRequest(localRequestId, {
            error: error instanceof Error ? error : new Error(String(error)),
          }));
      });
    }

    const requestId = `input-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const pending: PendingInputRequest = { agentId, resolve, reject };
      if (timeout !== Infinity) {
        pending.timer = setTimeout(() => {
          this.settleInputRequest(requestId, {
            error: new Error(`User input timeout after ${timeout}ms`),
          });
        }, timeout);
      }

      this.pendingInputRequests.set(requestId, pending);

      // 记录活跃请求（用于重连恢复）
      this.activeInputRequests.set(agentId, {
        requestId,
        prompt: request.prompt,
        placeholder: request.placeholder,
        initialValue: request.initialValue,
        actions: request.actions,
        mode: request.mode,
        questions: request.questions,
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
        mode: request.mode,
        questions: request.questions,
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
      const socket = connect(this.udsPath);
      this.udsClient = socket;

      socket.on('connect', () => {
        this.workerReadBuffer = '';
        this.clientReady = true;
        this.reconnectAttempts = 0; // 重置重连计数
        console.log(`[DebugHub] 已连接到 ViewerWorker: ${this.udsPath}`);

        // 关键：重新注册所有 Agent（用于重连后恢复状态）
        this.reregisterAllAgents();

        resolve();
      });

      socket.setEncoding('utf8');
      socket.on('data', (data: string) => {
        this.workerReadBuffer += data;
        const lines = this.workerReadBuffer.split('\n');
        this.workerReadBuffer = lines.pop() ?? '';
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

      socket.on('error', (err: Error) => {
        if (this.udsClient === socket) {
          this.udsClient = undefined;
          this.clientReady = false;
        }
        reject(new Error(`连接 ViewerWorker 失败 (${this.udsPath}): ${err.message}\n请先启动 ViewerWorker 服务器`));
      });

      socket.on('close', () => {
        this.workerReadBuffer = '';
        this.clientReady = false;
        if (this.udsClient === socket) {
          this.udsClient = undefined;
        }
        console.warn('[DebugHub] 与 ViewerWorker 的连接已断开');

        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * 处理来自 Worker 的消息
   */
  private handleWorkerMessage(msg: any): void {
    switch (msg.type) {
      // 处理用户输入响应
      case 'input-response': {
        if (this.pendingInputRequests.has(msg.requestId)) {
          this.settleInputRequest(msg.requestId, { response: msg.response ?? {
            kind: 'text',
            text: msg.input,
          } });
        } else {
          console.warn(`[DebugHub] 未知输入响应: ${msg.requestId}`);
        }
        break;
      }

      // 处理中断信号
      case 'interrupt-agent': {
        console.log(`[DebugHub] 收到中断信号: agentId=${msg.agentId}, knownAgents=[${[...this.agents.keys()].join(',')}]`);
        const agentData = this.agents.get(msg.agentId);
        console.log(`[DebugHub] agentData found=${!!agentData}, hasAgent=${!!agentData?.agent}, hasInterrupt=${typeof (agentData?.agent as any)?.interrupt}`);
        let interruptAccepted = false;
        if (agentData?.agent && typeof (agentData.agent as any).interrupt === 'function') {
          interruptAccepted = (agentData.agent as any).interrupt() === true;
          console.log(`[DebugHub] agent.interrupt() returned: ${interruptAccepted}`);
        } else {
          console.warn(`[DebugHub] Agent 不支持中断: ${msg.agentId}`);
        }
        // 中断生效时同步取消该 Agent 挂起的交互输入请求。工具内的输入
        // 等待已被 tool-executor 的 abort 竞争丢弃，若不在此结算 DebugHub
        // 租约，宿主输入循环重开 getUserInputEvent 会被 "already has an
        // active user input lease" 永久拒绝；同时 cancelInputRequests 会
        // 通知 Worker 清除 inputLease，解除对后续 user-turn 的阻塞。
        // 空闲宿主输入槽（interrupt 未被接受）不受影响。
        if (interruptAccepted) {
          this.cancelInputRequests(msg.agentId, `Agent '${msg.agentId}' was interrupted`);
        }
        const specificHandler = this.interruptHandlers.get(msg.agentId);
        const effectiveHandler = specificHandler ?? this.globalInterruptHandler;
        if (effectiveHandler) {
          Promise.resolve(effectiveHandler(msg.agentId, msg.clearQueue === true)).catch((error) => {
            console.error('[DebugHub] interruptHandler 执行失败:', error);
          });
        }
        break;
      }
    }
  }

  /**
   * 重新注册所有 Agent（重连后调用）
   * 确保 ViewerWorker 能够恢复所有 Agent 的注册信息
   */
  private reregisterAllAgents(): void {
    if (this.transportMode === 'claw') {
      for (const [id, data] of this.agents) {
        const hookInspector = (data.agent as any).buildHookInspectorSnapshot?.()
          || (data.agent as any).hookInspector;
        const overview = (data.agent as any).buildOverviewSnapshot?.();
        const templatePayload = this.agentTemplatePayload.get(id) || { mounts: [], entries: {} };

        void this.clawClient?.registerAgent({
          agentId: id,
          name: data.info.name,
          projectRoot: data.info.projectRoot || process.cwd(),
          templateMounts: templatePayload.mounts,
          templateEntries: templatePayload.entries,
          hookInspector,
          overview,
          inputPolicy: this.agentInputPolicy.get(id) || undefined,
        }).then(async () => {
          const tools = (data.agent as any).tools;
          if (tools && typeof tools.getEntries === 'function') {
            const entries = tools.getEntries();
            const toolList = entries.map((e: any) => e.tool);
            if (toolList.length > 0) {
              await this.clawClient?.registerTools(id, toolList);
            }
          }

          const context = (data.agent as any).getContext?.();
          if (context && typeof context.getAll === 'function') {
            const messages = context.getAll();
            if (messages.length > 0) {
              await this.clawClient?.pushMessages(id, messages);
            }
          }
        }).catch(error => {
          console.error(`[DebugHub] Claw re-register 失败: ${(error as Error).message}`);
        });
      }
      return;
    }

    if (this.agents.size === 0) {
      return;
    }

    console.log(`[DebugHub] 重新注册 ${this.agents.size} 个 Agent...`);

    for (const [id, data] of this.agents) {
      // 获取最新的 hookInspector
      const hookInspector = (data.agent as any).buildHookInspectorSnapshot?.()
        || (data.agent as any).hookInspector;
      const overview = (data.agent as any).buildOverviewSnapshot?.();

      // 获取缓存的模板装载载荷
      const templatePayload = this.agentTemplatePayload.get(id) || { mounts: [], entries: {} };

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
        projectRoot: data.info.projectRoot || process.cwd(),
        templateMounts: templatePayload.mounts,
        templateEntries: templatePayload.entries,
        hookInspector,
        overview,
        activeInputRequest, // 携带活跃输入请求
        inputPolicy: this.agentInputPolicy.get(id) || undefined,
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
    if (this.stopped) {
      return;
    }

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
        if (!this.stopped) {
          this.scheduleReconnect();
        }
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

  /** Cancel every input request owned by one Agent. Safe to call repeatedly. */
  cancelInputRequests(agentId: string, reason: string = `Agent '${agentId}' input was cancelled`): void {
    for (const [requestId, pending] of this.pendingInputRequests) {
      if (pending.agentId !== agentId) continue;
      pending.abortController?.abort();
      this.settleInputRequest(requestId, { error: this.createAbortError(reason) });
      // Worker 持有同名 inputLease（HTTP 投递面）；结算后必须同步通知
      // 清除，否则前端永远提交不到该 requestId，陈旧租约会阻塞后续
      // user-turn 与新输入租约的重开。按 requestId 匹配，不会误删
      // 紧随其后打开的新租约。
      this.sendToWorker({ type: 'input-request-cancelled', agentId, requestId });
    }
    this.activeInputRequests.delete(agentId);
  }

  private settleInputRequest(
    requestId: string,
    outcome: { response: UserInputResponse } | { error: Error },
  ): void {
    const pending = this.pendingInputRequests.get(requestId);
    if (!pending) return;

    this.pendingInputRequests.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    const active = this.activeInputRequests.get(pending.agentId);
    if (active?.requestId === requestId) {
      this.activeInputRequests.delete(pending.agentId);
    }

    if ('response' in outcome) {
      pending.resolve(outcome.response);
    } else {
      pending.reject(outcome.error);
    }
  }

  private createAbortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  /**
   * 发送消息到 Worker
   */
  private sendToWorker(msg: DebugHubIPCMessage): void {
    if (!this.udsClient || !this.clientReady) {
      // Do not present this as a delivered message. Stateful registrations and
      // input leases are reconciled by re-registerAllAgents on reconnect;
      // this warning keeps non-replayable debug updates observable instead of
      // silently pretending the transport accepted them. Warn once per message
      // type: headless runtimes (Test Runtime, one-shot agents) never connect.
      if (!this.sendToWorkerWarnedTypes.has(msg.type)) {
        this.sendToWorkerWarnedTypes.add(msg.type);
        console.warn(`[DebugHub] ViewerWorker transport is not ready; deferred state will reconcile on reconnect (message=${msg.type})`);
      }
      return;
    }
    this.sendViaUDS(msg);
  }
}
