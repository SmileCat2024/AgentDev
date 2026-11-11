
/**
 * Viewer Worker - 在独立进程中运行 HTTP 服务器
 * 支持多 Agent 调试，共享单端口
 * 支持通过 UDS（Unix Domain Socket）或 Windows Named Pipe 接收来自多进程的连接
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createServer as createNetServer, type Server, type Socket } from 'net';
import { unlinkSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { type DebugLogEntry, type AgentOverviewSnapshot, type AgentRuntimeStateSnapshot, type TodoPlanSnapshot, type TodoTaskSnapshot, type AgentSession, type DebugHubIPCMessage, type ImageInput, type InputLease, type InputRequestCancelledMsg, type QueuedInput, type TurnKind, type UserInputResponse, type UserTurnInput, type UserTurnSubmissionResult, getDefaultUDSPath } from '@agentdevjs/core';
import {
  DebuggerMCPServer,
  DEBUGGER_MCP_PROMPT_DEFINITIONS,
  DEBUGGER_MCP_RESOURCE_DEFINITIONS,
  DEBUGGER_MCP_TOOL_DEFINITIONS,
  createDebuggerAgentDetails,
  createDebuggerAgentSummary,
  filterDebuggerLogs,
  type DebuggerLogQuery,
} from './debugger-mcp.js';
import {
  TOOL_DISPLAY_NAMES,
  getToolRenderConfig
} from '@agentdevjs/core';
import { generateViewerHtml } from './viewer-html/index.js';

const QUERY_LOGS_DEFAULT_UNBOUNDED_LIMIT = 200;

/**
 * 消息变更分类（跨仓库契约，见 docs/adr/0012-message-poll-probe-tail.md）：
 * append=尾部新增、tail=末条改写、rewrite=中段替换 / 条数减少。
 */
type MessageChangeKind = 'append' | 'tail' | 'rewrite';

/**
 * 消息探测数据：挂在 /overview 响应 HTTP 组装层（不进 AgentOverviewSnapshot
 * 类型、不进 session.overview 存储），供前端把全量转录轮询降为按需取增量。
 */
export interface MessagesProbe {
  /**
   * 同步版本号（ADR-0012 v2）：仅在真实变更时单调递增。前端与已应用的
   * seq 对账决定是否取数——changeKind 只是"最近一次真实变更"的取数策略
   * 提示，不是同步真相；后到的 no-op 推送不得清掉未消费的变更记录。
   */
  seq: number;
  count: number;
  changeKind: MessageChangeKind | null;
  sinceIndex: number | null;
  fakeFullBytes: number;
}

/**
 * 进程内会话事件：内存写入点的对外投影，供宿主（如 Claw server）订阅后
 * 转发为 SSE 等推送通道。
 *
 * 轻载荷设计：事件只携带变更信号（kind + agentId + 少量状态性字段），
 * 快照 payload 由订阅方经 getXxxSnapshot() 按需组装——无订阅者时 emit
 * 近零开销，订阅方的事件合并窗口也不为被合并掉的中间事件白白组装快照。
 * messages 是唯一例外：probe 本身就是信号（几个数字字段），直接内联。
 *
 * 事件源完整性约束：每个改变前端可见状态的内存写入点都必须 emit
 * （包括非 IPC 路径：lease 提交、排队转交、注册对账），漏挂即前端状态
 * 滞留。清单见 Claw 侧 docs/sse-migration-bcd-preparation.md §2.3。
 */
export type ViewerSessionEvent =
  | { kind: 'notification'; agentId: string }
  | { kind: 'overview'; agentId: string }
  | { kind: 'todo'; agentId: string }
  | { kind: 'messages'; agentId: string; probe: MessagesProbe }
  | { kind: 'input-requests'; agentId: string }
  | { kind: 'queued-inputs'; agentId: string }
  | { kind: 'connection'; agentId: string; connected: boolean; reconnected: boolean };

export type ViewerSessionEventListener = (event: ViewerSessionEvent) => void;

/**
 * user-turn 自由元数据的形状约束：plain object、可序列化、≤16KB。
 * user-turn 端点与 lease 槽位提交（/input 的 response.payload.metadata）共用，
 * 两条入口保持同一防线。
 *
 * @returns null 表示合法；否则返回拒绝理由（HTTP 400 文案）。
 */
function validateTurnMetadata(metadata: unknown): string | null {
  let serialized: string | null = null;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    // 序列化失败保持 null，按非法 metadata 拒绝
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)
    || serialized === null || serialized.length > 16384) {
    return 'metadata must be a plain object of at most 16KB serialized';
  }
  return null;
}

// HTTP 面回环判定（ADR-0037 M5）：按字面量判定，不解析 DNS——bind 值
// 直接传给 net.Server.listen，可预测性优先。'0.0.0.0' / '::' 监听全部接口，
// 非回环可达，按非回环处理。
function isLoopbackHttpBind(bind: string): boolean {
  return bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';
}

// ============= Worker 类 =============

class ViewerWorker {
  private port: number;
  private openBrowser: boolean;
  private server: ReturnType<typeof createServer>;
  private udsPath: string;
  private udsServer?: Server;
  private tcpServer?: Server;
  private readonly tcpAddress?: { host: string; port: number };
  private readonly internalToken?: string;
  // HTTP 面绑定地址（ADR-0037 M5）：默认回环；显式非回环绑定（容器部署时
  // runtime 经 host.docker.internal 访问）时全端点强制 Bearer。
  private readonly httpBind: string;
  private readonly httpRequiresAuth: boolean;
  // 排队输入持久接管目录（ADR-0047 阶段 3a）：undefined = 内存队列（旧行为，
  // 兼容不落盘宿主）；传入目录则 per-agent 文件持久化，worker 重启后队列
  // 与已消费 sourceRef 记录恢复，接收端以 sourceRef 幂等去重。
  private readonly queuedInputStoreDir?: string;
  /**
   * 会话内已 ack 命令集（内存兜底，与持久 consumedSourceRefs 同容量语义）：
   * 无 storeDir 宿主的重复 ack 幂等判定；持久模式重启后由磁盘消费集接管。
   */
  private readonly consumedCommandAcks = new Map<string, Set<string>>();
  private udsClients: Map<string, Socket> = new Map();

  // 宿主定向请求的在途关联：requestId → pending。宿主断连（socket close /
  // error）时按 clientId 整批失败，避免 HTTP 调用方挂到超时。
  private hostRequestPendings: Map<string, {
    clientId: string;
    resolve: (value: { result?: unknown; error?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();

  // 多 Agent 会话存储
  private agentSessions: Map<string, AgentSession> = new Map();

  // 每个 agent 的资源注册载荷（ADR-0038）：agentId → { rootCount, entries }。
  // 根的真实路径留在 runtime 侧（resource.fetch 回源读取），worker 只认
  // rootId（0..rootCount-1）；URL = /res/{agentId}/{rootId}/{rel}。
  private templatePayloads: Map<string, { rootCount: number; entries: Record<string, { root: number; rel: string }> }> = new Map();

  private readonly debuggerMcp = new DebuggerMCPServer({
    listAgents: () => this.listAgentSummaries(),
    getAgent: (agentId: string) => this.getAgentDetails(agentId),
    getHooks: (agentId: string) => this.agentSessions.get(agentId)?.hookInspector,
    queryLogs: (query: DebuggerLogQuery) => this.queryLogs(query),
  });

  // 内存限制配置
  private readonly MAX_MESSAGES = 10000;
  private readonly MAX_BYTES = 50 * 1024 * 1024; // 50MB
  private readonly MAX_LOGS = 5000;

  constructor(port: number, openBrowser: boolean = true, udsPath?: string, options?: { queuedInputStoreDir?: string }) {
    this.port = port;
    this.openBrowser = openBrowser;
    this.udsPath = udsPath || getDefaultUDSPath();
    this.queuedInputStoreDir = options?.queuedInputStoreDir;
    const tcpAddress = process.env.AGENTDEV_VIEWER_ADDR;
    if (tcpAddress) {
      const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(tcpAddress);
      const tcpPort = match ? Number(match[3]) : NaN;
      if (!match || !Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
        throw new Error(`Invalid AGENTDEV_VIEWER_ADDR: ${tcpAddress}`);
      }
      this.tcpAddress = { host: match[1] || match[2], port: tcpPort };
      this.internalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
      if (!this.internalToken) {
        throw new Error('PROTOCLAW_INTERNAL_TOKEN is required when AGENTDEV_VIEWER_ADDR is set');
      }
    }
    this.httpBind = process.env.AGENTDEV_VIEWER_HTTP_BIND || '127.0.0.1';
    this.httpRequiresAuth = !isLoopbackHttpBind(this.httpBind);
    if (this.httpRequiresAuth && !tcpAddress) {
      // 非回环 HTTP 面与 TCP 控制通道同一信任模型（ADR-0037）：跨出本机
      // 即要求共享内部 token。tcpAddress 已校验过，不重复抛。
      this.internalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
      if (!this.internalToken) {
        throw new Error('PROTOCLAW_INTERNAL_TOKEN is required when AGENTDEV_VIEWER_HTTP_BIND is non-loopback');
      }
    }
    this.server = createServer();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 先启动 HTTP 服务器，成功后再 bind UDS。顺序不可反：startUDSServer
      // 会 unlink 路径上的现有 sock 文件，若 HTTP 端口已占用（如误启动的
      // 第二个实例），先 bind UDS 会破坏既有实例的 IPC 通道且失败退出时
      // 无清理，留下无 listener 的死 sock，令所有后续连接方永久失联。
      this.server.on('request', (req, res) => this.handleRequest(req, res));

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 被占用`));
        } else {
          reject(err);
        }
      });

      // HTTP 面默认保持回环（本机 debug/control 传输，产品公共入口是 Claw
      // server）。非回环绑定仅经 AGENTDEV_VIEWER_HTTP_BIND 显式开启（容器
      // 部署，ADR-0037 M5），开启后全端点强制 Bearer（见 handleRequest）。
      this.server.listen(this.port, this.httpBind, async () => {
        try {
          const url = `http://${this.httpBind}:${this.port}`;
          console.log(`[Viewer Worker] ${url}${this.httpRequiresAuth ? ' (Bearer auth required)' : ' (loopback only)'}`);
          console.log(`[Viewer Worker] MCP endpoint: ${url}/mcp`);

          // HTTP 就绪后才接管本机 UDS 与可选网络传输。
          await this.startUDSServer();
          if (this.tcpAddress) await this.startTCPServer();

          // 打开浏览器（仅在 openBrowser 为 true 时）。浏览器在本机访问，
          // 非回环 bind（如 0.0.0.0）不是有效访问地址，固定用回环。
          if (this.openBrowser) {
            const browserUrl = `http://127.0.0.1:${this.port}`;
            try {
              const open = await import('open');
              await open.default(browserUrl).catch(() => {
                console.warn('[Viewer Worker] 浏览器打开失败，请手动访问: ' + browserUrl);
              });
            } catch {
              console.warn('[Viewer Worker] open 模块不可用，请手动访问: ' + browserUrl);
            }
          }

          // 通知主进程服务器已启动
          if (process.send) {
            process.send({ type: 'ready' });
          }

          resolve();
        } catch (err) {
          await this.stop();
          reject(err);
        }
      });
    });
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      let pendingCloseCallbacks = 0;
      const finishClose = () => {
        pendingCloseCallbacks -= 1;
        if (pendingCloseCallbacks === 0) resolve();
      };

      // 关闭 HTTP 服务器
      if (this.server) {
        pendingCloseCallbacks += 1;
        this.server.close(() => {
          console.log('[Viewer Worker] HTTP 服务器已关闭');
          finishClose();
        });
      }

      // 关闭传输监听器
      if (this.tcpServer) {
        pendingCloseCallbacks += 1;
        this.tcpServer.close(() => {
          console.log('[Viewer Worker] TCP 服务器已关闭');
          finishClose();
        });
        this.tcpServer = undefined;
      }
      if (this.udsServer) {
        pendingCloseCallbacks += 1;
        this.udsServer.close(() => {
          console.log('[Viewer Worker] UDS 服务器已关闭');
          finishClose();
        });
      }

      // 关闭所有控制通道客户端连接
      for (const [id, socket] of this.udsClients) {
        socket.destroy();
        console.log(`[Viewer Worker] 客户端连接已关闭: ${id}`);
      }
      this.udsClients.clear();

      // 清理 Unix socket 文件（非 Windows）。只有本实例真正 bind 过 UDS
      // （udsServer 存在）才允许 unlink：start() 可能在接管路径之前就失败
      // （HTTP 端口冲突），此时路径上的文件属于另一个实例，删掉它等于
      // 拆掉别人的 IPC 通道。
      if (process.platform !== 'win32' && this.udsServer && this.udsPath && existsSync(this.udsPath)) {
        try {
          unlinkSync(this.udsPath);
        } catch {}
      }

      if (pendingCloseCallbacks === 0) resolve();
    });
  }

  // ========== UDS 服务器 ==========

  /**
   * 启动 UDS 服务器（listen 完成或出错时 settle）
   */
  private startUDSServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 清理旧 socket 文件（非 Windows）
      if (process.platform !== 'win32' && existsSync(this.udsPath)) {
        try {
          unlinkSync(this.udsPath);
        } catch {}
      }

      // 客户端连接计数器，用于生成唯一 ID
      let connectionCounter = 0;

      this.udsServer = createNetServer((socket: Socket) => {
        // 使用计数器生成唯一 ID，而不是依赖 remoteAddress/port（Windows 命名管道可能返回 undefined）
        const clientId = `client-${++connectionCounter}-${Date.now()}`;
        this.udsClients.set(clientId, socket);

        console.log(`[Viewer Worker] 新的 UDS 客户端连接: ${clientId}, 当前连接数: ${this.udsClients.size}`);

        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (data: string) => {
          buffer += data;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg: DebugHubIPCMessage = JSON.parse(line);
              this.handleUDSMessage(msg, socket, clientId);
            } catch (err) {
              console.error('[Viewer Worker] UDS 消息解析失败:', err);
            }
          }
        });

        socket.on('close', () => {
          this.udsClients.delete(clientId);
          console.log(`[Viewer Worker] UDS 客户端断开: ${clientId}, 当前连接数: ${this.udsClients.size}`);
          // 一个 UDS 连接可承载多个 agent session：反查受影响 agent 并广播
          // 断连事件（close 回调只携带 clientId）。此时 session.clientId 仍
          // 指向该连接，isSessionConnected 因 udsClients 已删而自然为 false。
          this.emitDisconnectedByClientId(clientId);
        });

        socket.on('error', (err) => {
          console.error('[Viewer Worker] UDS 客户端错误:', err);
          this.udsClients.delete(clientId);
          // error 后不保证还有 close：同样广播断连（connected:false 幂等）
          this.emitDisconnectedByClientId(clientId);
        });
      });

      // 错误处理：bind 失败必须让 start() 感知（此前仅打日志会被吞掉）
      this.udsServer.on('error', (err: Error) => {
        console.error(`[Viewer Worker] UDS 服务器错误: ${err.message}`);
        reject(err);
      });

      this.udsServer.listen(this.udsPath, () => {
        console.log(`[Viewer Worker] UDS 服务器已启动: ${this.udsPath}`);
        resolve();
      });
    });
  }

  /** TCP 控制通道在首条业务消息前必须完成内部 token 认证。 */
  private startTCPServer(): Promise<void> {
    const address = this.tcpAddress;
    const token = this.internalToken;
    if (!address || !token) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let connectionCounter = 0;
      this.tcpServer = createNetServer((socket: Socket) => {
        const clientId = `tcp-client-${++connectionCounter}-${Date.now()}`;
        let buffer = '';
        let authenticated = false;
        socket.setEncoding('utf8');
        socket.on('data', (data: string) => {
          buffer += data;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let message: any;
            try {
              message = JSON.parse(line);
            } catch {
              socket.destroy();
              return;
            }
            if (!authenticated) {
              if (message?.type !== 'auth' || typeof message.token !== 'string' || message.token !== token) {
                socket.write(JSON.stringify({ type: 'auth-error' }) + '\n', () => socket.destroy());
                return;
              }
              authenticated = true;
              this.udsClients.set(clientId, socket);
              socket.write(JSON.stringify({ type: 'auth-ok' }) + '\n');
              console.log(`[Viewer Worker] 已认证 TCP 客户端: ${clientId}`);
              continue;
            }
            this.handleUDSMessage(message as DebugHubIPCMessage, socket, clientId);
          }
        });
        socket.on('close', () => {
          if (!authenticated) return;
          this.udsClients.delete(clientId);
          this.emitDisconnectedByClientId(clientId);
        });
        socket.on('error', (err) => {
          console.error('[Viewer Worker] TCP 客户端错误:', err);
          if (authenticated) {
            this.udsClients.delete(clientId);
            this.emitDisconnectedByClientId(clientId);
          }
        });
      });
      this.tcpServer.once('error', (error) => {
        this.tcpServer = undefined;
        reject(error);
      });
      this.tcpServer.listen(address.port, address.host, () => {
        console.log(`[Viewer Worker] TCP 控制通道已监听: ${address.host}:${address.port}`);
        resolve();
      });
    });
  }

  /**
   * 处理 UDS 消息（复用现有处理方法）
   */
  private handleUDSMessage(msg: DebugHubIPCMessage, socket: Socket, clientId: string): void {
    switch (msg.type) {
      case 'register-agent':
        this.handleRegisterAgent(msg, clientId);
        break;
      case 'update-agent-inspector':
        this.handleUpdateAgentInspector(msg);
        break;
      case 'update-agent-overview':
        this.handleUpdateAgentOverview(msg);
        break;
      case 'update-todo-plan':
        this.handleUpdateTodoPlan(msg);
        break;
      case 'push-messages':
        this.handlePushMessages(msg);
        break;
      case 'register-tools':
        this.handleRegisterTools(msg);
        break;
      case 'unregister-agent':
        this.handleUnregisterAgent(msg);
        break;
      case 'push-notification':
        this.handlePushNotification(msg);
        break;
      case 'request-input':
        this.handleRequestInput(msg);
        break;
      case 'input-request-cancelled':
        this.handleInputRequestCancelled(msg);
        break;
      case 'stop':
        this.handleStop();
        break;
      case 'host-response': {
        // requestId 关联的宿主定向请求回传：无对应 pending（已超时/断连
        // 清理）时静默丢弃。
        const pending = this.hostRequestPendings.get(msg.requestId);
        if (pending) {
          this.hostRequestPendings.delete(msg.requestId);
          pending.resolve({ result: (msg as { result?: unknown }).result, error: (msg as { error?: string }).error });
        }
        break;
      }
    }
  }

  // ========== HTTP 请求处理 ==========

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    // 非回环绑定（AGENTDEV_VIEWER_HTTP_BIND 显式开启，ADR-0037 M5）时
    // 全端点强制 Bearer：HTTP 面是 internal debug/control 传输，跨出本机的
    // 合法消费方只有持有 PROTOCLAW_INTERNAL_TOKEN 的 runtime（dequeue 轮询，
    // react-loop 侧 M2 已实现携带）。回环绑定不校验，行为与历史完全一致。
    if (this.httpRequiresAuth) {
      if (req.headers.authorization !== `Bearer ${this.internalToken}`) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unauthorized');
        return;
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 路由分发
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const url = urlObj.pathname;

    // 主页
    if (url === '/' || url === '/index.html') {
      this.handleIndex(req, res);
      return;
    }

    // API 端点
    if (url.startsWith('/api/')) {
      this.handleAPI(req, res);
      return;
    }

    if (url === '/mcp' || url === '/mcp/') {
      void this.handleMCP(req, res);
      return;
    }

    // 资源读取协议资产（ADR-0038）：/res/{agentId}/{rootId}/{rel}。
    // 文件在 runtime 侧（本地 / 容器 / 外部同链路），worker 经 host-request
    // 回源；URL 层级与根内磁盘层级同构，模板相对依赖（chunk、sourcemap）
    // 按相同布局自然命中。
    if (url.startsWith('/res/')) {
      this.handleResAsset(req, res, url);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  /**
   * 主页 - 带多 Agent 切换器
   */
  private handleIndex(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(this.getHtml());
  }

  /**
   * API 端点路由
   */
  private handleAPI(req: IncomingMessage, res: ServerResponse): void {
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const url = urlObj.pathname;

    // GET /api/agents - Agent 列表
    if (url === '/api/agents' && req.method === 'GET') {
      this.handleGetAgents(req, res);
      return;
    }

    // GET /api/templates/feature - 获取 Feature 模板映射
    if (url === '/api/templates/feature' && req.method === 'GET') {
      this.handleGetFeatureTemplates(req, res, urlObj.searchParams);
      return;
    }

    if (url === '/api/logs' && req.method === 'GET') {
      this.handleGetLogs(req, res, urlObj.searchParams);
      return;
    }

    if (url === '/api/mcp-info' && req.method === 'GET') {
      this.handleGetMCPInfo(req, res);
      return;
    }

    // GET /api/agents/:id/messages - 指定 Agent 的消息
    const msgMatch = url.match(/^\/api\/agents\/([^/]+)\/messages$/);
    if (msgMatch && req.method === 'GET') {
      this.handleGetAgentMessages(req, res, msgMatch[1], urlObj.searchParams);
      return;
    }

    // GET /api/agents/:id/tools - 指定 Agent 的工具
    const toolsMatch = url.match(/^\/api\/agents\/([^/]+)\/tools$/);
    if (toolsMatch && req.method === 'GET') {
      this.handleGetAgentTools(req, res, toolsMatch[1]);
      return;
    }

    // GET /api/agents/:id/hooks - 指定 Agent 的 hook 监视快照
    const hooksMatch = url.match(/^\/api\/agents\/([^/]+)\/hooks$/);
    if (hooksMatch && req.method === 'GET') {
      this.handleGetAgentHooks(req, res, hooksMatch[1]);
      return;
    }

    // GET /api/agents/:id/overview - 指定 Agent 的概览统计
    const overviewMatch = url.match(/^\/api\/agents\/([^/]+)\/overview$/);
    if (overviewMatch && req.method === 'GET') {
      this.handleGetAgentOverview(req, res, overviewMatch[1]);
      return;
    }

    // GET /api/agents/:id/todo - 指定 Agent 的 todo/plan 快照
    const todoMatch = url.match(/^\/api\/agents\/([^/]+)\/todo$/);
    if (todoMatch && req.method === 'GET') {
      this.handleGetAgentTodoPlan(req, res, todoMatch[1]);
      return;
    }

    // GET /api/agents/:id/notification - 指定 Agent 的通知状态
    const notifMatch = url.match(/^\/api\/agents\/([^/]+)\/notification$/);
    if (notifMatch && req.method === 'GET') {
      this.handleGetAgentNotification(req, res, notifMatch[1]);
      return;
    }

    // GET /api/agents/:id/connection - 指定 Agent 的真实连接状态
    const connectionMatch = url.match(/^\/api\/agents\/([^/]+)\/connection$/);
    if (connectionMatch && req.method === 'GET') {
      this.handleGetAgentConnection(req, res, connectionMatch[1]);
      return;
    }

    // DELETE /api/agents/:id - 删除已断开的 Agent 会话
    const deleteAgentMatch = url.match(/^\/api\/agents\/([^/]+)$/);
    if (deleteAgentMatch && req.method === 'DELETE') {
      this.handleDeleteAgent(req, res, deleteAgentMatch[1]);
      return;
    }

    // GET /api/agents/:id/input-requests - 获取输入请求列表
    const inputReqMatch = url.match(/^\/api\/agents\/([^/]+)\/input-requests$/);
    if (inputReqMatch && req.method === 'GET') {
      this.handleGetInputRequests(req, res, inputReqMatch[1]);
      return;
    }

    // POST /api/agents/:id/input - 提交用户输入
    const inputPostMatch = url.match(/^\/api\/agents\/([^/]+)\/input$/);
    if (inputPostMatch && req.method === 'POST') {
      this.handlePostInput(req, res, inputPostMatch[1]);
      return;
    }

    // POST /api/agents/:id/user-turn - 统一提交一个新的用户回合
    const userTurnMatch = url.match(/^\/api\/agents\/([^/]+)\/user-turn$/);
    if (userTurnMatch && req.method === 'POST') {
      this.handlePostUserTurn(req, res, userTurnMatch[1]);
      return;
    }

    // GET /api/agents/:id/queued-inputs - 获取排队中的用户输入
    const queuedInputsMatch = url.match(/^\/api\/agents\/([^/]+)\/queued-inputs$/);
    if (queuedInputsMatch && req.method === 'GET') {
      this.handleGetQueuedInputs(req, res, queuedInputsMatch[1]);
      return;
    }

    // POST /api/agents/:id/command-input/claim - durable WorkThread receipt claim
    const commandClaimMatch = url.match(/^\/api\/agents\/([^/]+)\/command-input\/claim$/);
    if (commandClaimMatch && req.method === 'POST') {
      const input = this.claimCommandInput(commandClaimMatch[1]);
      res.writeHead(input ? 200 : 204, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(input ? JSON.stringify({ input }) : '');
      return;
    }

    // POST /api/agents/:id/command-input/ack - remove only the matching durable claim
    const commandAckMatch = url.match(/^\/api\/agents\/([^/]+)\/command-input\/ack$/);
    if (commandAckMatch && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { receipt } = JSON.parse(body || '{}');
          const acknowledged = this.acknowledgeCommandInput(commandAckMatch[1], receipt);
          res.writeHead(acknowledged ? 200 : 409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ acknowledged }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ acknowledged: false, error: 'Invalid receipt' }));
        }
      });
      return;
    }

    // POST /api/agents/:id/dequeue-input - legacy input consumption
    const dequeueMatch = url.match(/^\/api\/agents\/([^/]+)\/dequeue-input$/);
    if (dequeueMatch && req.method === 'POST') {
      this.handleDequeueInput(req, res, dequeueMatch[1]);
      return;
    }

    // POST /api/agents/:id/interrupt - 中断正在运行的 Agent
    const interruptMatch = url.match(/^\/api\/agents\/([^/]+)\/interrupt$/);
    if (interruptMatch && req.method === 'POST') {
      this.handleInterrupt(req, res, interruptMatch[1]);
      return;
    }

    // POST /api/agents/:id/stop - 请求 runtime 优雅停止（外部 runtime 生命周期通道）
    const stopMatch = url.match(/^\/api\/agents\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      this.handleStopAgent(req, res, stopMatch[1]);
      return;
    }

    // POST /api/agents/:id/host-request - 宿主定向请求（与 stop 同一连接通道的
    // 请求/响应扩展，requestId 关联，runtime 以 host-response 帧回传）
    const hostRequestMatch = url.match(/^\/api\/agents\/([^/]+)\/host-request$/);
    if (hostRequestMatch && req.method === 'POST') {
      this.handleHostRequest(req, res, hostRequestMatch[1]);
      return;
    }

    // GET /api/agents/:id/running - 查询 Agent 是否正在运行
    const runningMatch = url.match(/^\/api\/agents\/([^/]+)\/running$/);
    if (runningMatch && req.method === 'GET') {
      this.handleGetRunning(req, res, runningMatch[1]);
      return;
    }

    res.writeHead(404);
    res.end('API Not Found');
  }

  // ========== API 处理器 ==========

  /**
   * GET /api/agents - 获取所有 Agent
   */
  private handleGetAgents(req: IncomingMessage, res: ServerResponse): void {
    const agents = Array.from(this.agentSessions.values()).map(session => ({
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      messageCount: session.messages.length,
      connected: this.isSessionConnected(session),
      inputAccepted: session.inputPolicy !== 'none',
      // 活跃输入租约标志：前端用它做焦点恢复（inputRequest 优先）
      pendingInputCount: session.inputLease ? 1 : 0,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      agents,
    }));
  }

  /**
   * GET /api/templates/feature - 获取 Feature 模板映射
   */
  public handleGetFeatureTemplates(req: IncomingMessage, res: ServerResponse, searchParams?: URLSearchParams): void {
    // 目标 agentId 必须显式指定（焦点语义已前端化，服务端不再有"当前 Agent"）
    const targetAgentId = searchParams?.get('agentId') || null;
    if (!targetAgentId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'agentId query parameter is required' }));
      return;
    }

    const payload = this.templatePayloads.get(targetAgentId);
    if (!payload || Object.keys(payload.entries).length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{}');
      return;
    }

    // URL = /res/{agentId}/{rootId}/{rel}（ADR-0038）。agentId 限定归属：
    // 不同 runtime（含容器）内同路径根内容可不同，必须按 runtime 隔离；
    // chunk 相对 import 在同前缀下天然命中。URL 不跨 runtime 代稳定，
    // 每次经本端点获取映射。
    const featureTemplateMapForFrontend: Record<string, string> = {};
    for (const [templateName, entry] of Object.entries(payload.entries)) {
      featureTemplateMapForFrontend[templateName] = `/res/${encodeURIComponent(targetAgentId)}/${entry.root}/${entry.rel}`;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(featureTemplateMapForFrontend));
  }


  /**
   * 解析 npm workspace 符号链接
   * 当 Feature 来自 npm workspace 时，import.meta.url 返回的是符号链接的真实物理路径
   * 需要检查 node_modules 目录中的符号链接来确定包名
   */
  private npmWorkspaceCache: Map<string, string> = new Map();

  private resolveNpmWorkspacePackage(normalizedPath: string, projectRoot: string): string | null {
    // 从路径中提取可能的包根目录（包含 dist/features 的目录）
    const featuresMatch = normalizedPath.match(/^(.+)\/dist\/features\/([^/]+)\/templates\/(.+\.render\.js)$/);
    if (!featuresMatch) {
      return null;
    }

    const [, packageRoot, featureName, templateFile] = featuresMatch;
    const normalizedProjectRoot = projectRoot.replace(/\\/g, '/');

    // 检查缓存
    const cacheKey = `${normalizedProjectRoot}:${packageRoot}`;
    if (this.npmWorkspaceCache.has(cacheKey)) {
      const packageName = this.npmWorkspaceCache.get(cacheKey)!;
      return `/npm/${packageName}/features/${featureName}/${templateFile}`;
    }

    // 扫描 node_modules 目录查找符号链接
    const nodeModulesPath = join(normalizedProjectRoot, 'node_modules');
    try {
      const fs = require('fs');
      if (!fs.existsSync(nodeModulesPath)) {
        return null;
      }

      const entries = fs.readdirSync(nodeModulesPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          const linkPath = join(nodeModulesPath, entry.name);
          try {
            // 解析符号链接的真实路径
            const realPath = fs.realpathSync(linkPath).replace(/\\/g, '/');
            
            // 检查包根目录是否匹配
            if (realPath === packageRoot || realPath + '/dist' === packageRoot) {
              // 找到匹配的包！缓存结果
              this.npmWorkspaceCache.set(cacheKey, entry.name);
              console.log(`[Viewer Worker] 解析 npm workspace 符号链接: ${entry.name} -> ${realPath}`);
              return `/npm/${entry.name}/features/${featureName}/${templateFile}`;
            }
          } catch {
            // 忽略无法解析的符号链接
          }
        }
      }
    } catch {
      // 忽略扫描错误
    }

    return null;
  }

  /**
   * GET /api/agents/:id/messages - 获取指定 Agent 的消息
   *
   * 增量取数（ADR-0012）：?since=<n> 返回自下标 n 起的尾部切片（附 baseCount）；
   * ?tail=1 返回最后一条。无参数路径的响应形状与历史完全一致（全量数组）。
   *
   * `timestamps` 是与 messages 等长对齐的时间元表（毫秒；null = 无时间锚）。
   * runtime 从未推送时间数据时省略该字段，消费方按"全部无时间锚"降级。
   */
  private handleGetAgentMessages(req: IncomingMessage, res: ServerResponse, agentId: string, searchParams?: URLSearchParams): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const timestamps = (session as any)._messageTimestamps as (number | null)[] | undefined;
    const aligned = Array.isArray(timestamps) && timestamps.length === session.messages.length
      ? timestamps
      : undefined;

    const since = searchParams?.get('since');
    if (since !== null && since !== undefined) {
      const n = Number.parseInt(since, 10);
      if (Number.isNaN(n) || n < 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid since parameter' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      // n > length 时 slice 自然返回空数组，客户端按长度校验降级全量拉
      res.end(JSON.stringify({
        messages: session.messages.slice(n),
        baseCount: n,
        ...(aligned ? { timestamps: aligned.slice(n) } : {}),
      }));
      return;
    }

    if (searchParams?.get('tail') === '1') {
      const last = session.messages.length > 0 ? session.messages[session.messages.length - 1] : null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        messages: last ? [last] : [],
        ...(aligned && last ? { timestamps: [aligned[aligned.length - 1]] } : {}),
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      agentId,
      messages: session.messages,
      ...(aligned ? { timestamps: aligned } : {}),
    }));
  }

  /**
   * GET /api/agents/:id/tools - 获取指定 Agent 的工具
   */
  private handleGetAgentTools(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(session.tools));
  }

  private handleGetAgentHooks(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(session.hookInspector || {
      lifecycleOrder: [],
      features: [],
      hooks: [],
    }));
  }

  private handleGetAgentOverview(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    // 消息探测只挂 HTTP 组装层（ADR-0012）：前端 normalizeOverviewSnapshot
    // 剥离未知字段，快照类型与 session.overview 存储不受污染。探测不可用
    // （未走过推送路径）时字段整体缺省。
    res.end(JSON.stringify(this.getOverviewSnapshot(agentId)));
  }

  private handleGetAgentTodoPlan(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(this.getTodoSnapshot(agentId)));
  }

  /**
   * GET /api/agents/:id/notification - 获取指定 Agent 的通知状态
   */
  private handleGetAgentNotification(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const snapshot = this.getNotificationSnapshot(agentId)!;
    const hasNewEvents = session.events.length > session.lastEventCount;
    session.lastEventCount = session.events.length;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ...snapshot,
      hasNewEvents,
    }));
  }

  private handleGetLogs(req: IncomingMessage, res: ServerResponse, searchParams: URLSearchParams): void {
    const scope = searchParams.get('scope') === 'all' ? 'all' : 'current';
    const agentId = searchParams.get('agentId');
    if (scope === 'current' && !agentId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false,
        code: 'invalid_target',
        error: 'agentId query parameter is required for current logs',
      }));
      return;
    }

    const result = this.queryLogs({
      scope,
      agentId,
      level: searchParams.get('level') || undefined,
      namespace: searchParams.get('namespace') || undefined,
      feature: searchParams.get('feature') || undefined,
      lifecycle: searchParams.get('lifecycle') || undefined,
      from: this.parseNumberParam(searchParams.get('from')),
      to: this.parseNumberParam(searchParams.get('to')),
      limit: this.parseNumberParam(searchParams.get('limit')),
      offset: this.parseNumberParam(searchParams.get('offset')),
      search: searchParams.get('search') || undefined,
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  }

  private handleGetMCPInfo(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host || `localhost:${this.port}`;
    const origin = `http://${host}`;
    const endpoint = `${origin}/mcp`;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      enabled: true,
      endpoint,
      transport: 'Streamable HTTP',
      version: 'read-only debugger facade',
      commands: {
        claudeDesktop: {
          json: {
            mcpServers: {
              agentdevDebugger: {
                type: 'http',
                url: endpoint,
              },
            },
          },
        },
        codex: {
          json: {
            servers: {
              agentdevDebugger: {
                type: 'http',
                url: endpoint,
              },
            },
          },
        },
        curlInitialize: `curl -X POST ${endpoint} -H "Content-Type: application/json" -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"initialize\\",\\"params\\":{\\"protocolVersion\\":\\"2025-03-26\\",\\"capabilities\\":{},\\"clientInfo\\":{\\"name\\":\\"manual-client\\",\\"version\\":\\"1.0.0\\"}}}"`,
      },
      tools: DEBUGGER_MCP_TOOL_DEFINITIONS,
      resources: DEBUGGER_MCP_RESOURCE_DEFINITIONS,
      prompts: DEBUGGER_MCP_PROMPT_DEFINITIONS,
    }));
  }

  /**
   * GET /api/agents/:id/connection - 获取指定 Agent 的真实连接状态
   */
  private handleGetAgentConnection(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const connected = this.isAgentConnected(agentId)!;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ connected }));
  }

  /**
   * DELETE /api/agents/:id - 删除已断开的 Agent 会话
   */
  private handleDeleteAgent(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    if (this.isSessionConnected(session)) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Connected agent cannot be deleted' }));
      return;
    }

    this.agentSessions.delete(agentId);
    console.log(`[Viewer Worker] 已删除断开的 Agent 会话: ${agentId}`);
    this.emitSessionEvent({ kind: 'connection', agentId, connected: false, reconnected: false });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      agentId,
    }));
  }

  /**
   * 获取输入请求列表
   */
  private handleGetInputRequests(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const requests = this.getInputRequestsSnapshot(agentId)!;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(requests));
  }

  /**
   * 提交用户输入
   */
  private handlePostInput(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { requestId, input, response } = JSON.parse(body);

        const session = this.agentSessions.get(agentId);
        const lease = session?.inputLease;
        if (!session || !lease || lease.requestId !== requestId) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Request not found or expired' }));
          return;
        }

        const normalizedResponse = response ?? {
          kind: 'text',
          text: input,
        };

        // lease 槽位提交同样可以携带 user-turn metadata（前端 slot 路径把它放进
        // response.payload）：与 user-turn 端点共用同一形状防线，避免槽位路径
        // 绕过尺寸约束把超大元数据直推进 runtime
        const slotMetadata = (normalizedResponse as { payload?: { metadata?: unknown } })?.payload?.metadata;
        if (slotMetadata !== undefined) {
          const rejection = validateTurnMetadata(slotMetadata);
          if (rejection) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, code: 'invalid_input', error: rejection }));
            return;
          }
        }

        if (!this.forwardInputResponse(agentId, session, requestId, input ?? '', normalizedResponse)) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: false,
            code: 'runtime_not_accepting_input',
            error: 'Agent runtime is not connected',
          }));
          return;
        }

        // IPC 接管成功后再移除请求，避免“HTTP 成功但消息未发送”的假成功。
        delete session.inputLease;
        this.emitSessionEvent({ kind: 'input-requests', agentId });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  /**
   * 提交一个不绑定 requestId 的新用户回合。
   *
   * inputLease 与 queuedInputs 都由 ViewerWorker 持有，因此仲裁必须
   * 在这里原子完成，不能由宿主先 GET 再 POST 拼接，否则会产生 TOCTOU 竞态。
   */
  public submitUserTurn(agentId: string, input: UserTurnInput): UserTurnSubmissionResult {
    // 'resume'（空消息续跑）：text 允许为空——模型凭尾部工作现场自然续作，
    // 消息内容由 agent 层启动前补齐；其余 kind 仍要求非空文本。
    if (!input || typeof input.text !== 'string' || (input.text.length === 0 && input.kind !== 'resume')) {
      return { success: false, code: 'invalid_input', error: 'text must be a non-empty string' };
    }
    if (input.kind !== undefined && input.kind !== 'user' && input.kind !== 'reminder' && input.kind !== 'resume') {
      return { success: false, code: 'invalid_input', error: "kind must be 'user', 'reminder' or 'resume' when provided" };
    }
    if (input.images !== undefined && !Array.isArray(input.images)) {
      return { success: false, code: 'invalid_input', error: 'images must be an array when provided' };
    }
    if (input.source !== undefined
      && (typeof input.source !== 'string' || input.source.length === 0 || input.source.length > 128)) {
      return { success: false, code: 'invalid_input', error: 'source must be a non-empty string up to 128 characters' };
    }
    if (input.sourceRef !== undefined
      && (typeof input.sourceRef !== 'string' || input.sourceRef.length === 0 || input.sourceRef.length > 512)) {
      return { success: false, code: 'invalid_input', error: 'sourceRef must be a non-empty string up to 512 characters' };
    }
    if (input.sessionId !== undefined
      && (typeof input.sessionId !== 'string' || input.sessionId.length === 0 || input.sessionId.length > 128)) {
      return { success: false, code: 'invalid_input', error: 'sessionId must be a non-empty string up to 128 characters' };
    }
    if (input.commandIdentity !== undefined) {
      const identity = input.commandIdentity;
      if (!identity || typeof identity.commandId !== 'string' || !identity.commandId
        || typeof identity.threadId !== 'string' || !identity.threadId
        || !Number.isInteger(identity.headGeneration) || identity.headGeneration < 0
        || input.kind === 'reminder' || input.kind === 'resume') {
        return { success: false, code: 'invalid_input', error: 'commandIdentity must identify a user WorkThread command' };
      }
    }
    if (input.capabilityActivations !== undefined
      && (!Array.isArray(input.capabilityActivations)
        || input.capabilityActivations.length > 16
        || input.capabilityActivations.some((a) => typeof a !== 'string' || a.length === 0 || a.length > 128))) {
      return { success: false, code: 'invalid_input', error: 'capabilityActivations must be an array of up to 16 non-empty strings (max 128 chars each)' };
    }
    if (input.metadata !== undefined) {
      const rejection = validateTurnMetadata(input.metadata);
      if (rejection) {
        return { success: false, code: 'invalid_input', error: rejection };
      }
    }

    const session = this.agentSessions.get(agentId);
    if (!session) {
      return { success: false, code: 'agent_not_found', error: 'Agent not found' };
    }
    if (!this.isSessionConnected(session)) {
      return {
        success: false,
        code: 'runtime_not_accepting_input',
        error: 'Agent runtime is not connected',
      };
    }

    // reminder（机器通报）与 resume（空消息续跑）都不冒充用户：跳过输入
    // 租约应答与 choices 冲突检查（409 拦的是真人输入），直接进入会话邮箱
    // 排队，由空闲邮箱消费循环或 call 内注入落地。
    const isReminder = input.kind === 'reminder';
    const isNonUserTurn = isReminder || input.kind === 'resume';

    const lease = session.inputLease;
    if (!isNonUserTurn && lease?.mode === 'choices') {
      return {
        success: false,
        code: 'input_mode_conflict',
        error: 'A non-text interactive input request must be completed before submitting a new user turn',
        pendingMode: 'choices',
      };
    }

    // 接收端幂等去重（ADR-0047 阶段 3a）：带 sourceRef 的重复投递不重复
    // 接收——投递方在标记 delivered 前崩溃重试、或消费回执丢失后重试，
    // 同一 commandId 幂等返回。两层：未消费（队列内，含重启恢复的持久
    // 队列）返回既有排队项；已消费返回幂等成功（不重新执行）。无
    // sourceRef 的输入（前端直发用户消息）不去重，保持原语义。
    // 检查位置必须在 lease 直接应答之前：否则重复投递遇活动 lease 会
    // 绕过两层去重被再次转交执行（阶段 3 审查裁定）。
    if (input.commandIdentity) {
      const inQueue = session.queuedInputs.find((q) => q.commandIdentity?.threadId === input.commandIdentity!.threadId
        && q.commandIdentity?.commandId === input.commandIdentity!.commandId);
      if (inQueue) {
        return { success: true, delivery: 'queued', id: inQueue.id, queueLength: session.queuedInputs.length, duplicate: true, source: input.source, sourceRef: input.sourceRef };
      }
    }
    if (input.commandIdentity && (session.threadId !== input.commandIdentity.threadId
      || session.headGeneration !== input.commandIdentity.headGeneration
      || input.sessionId !== session.workSessionId)) {
      return { success: false, code: 'runtime_not_accepting_input', error: 'Command identity does not match the registered WorkThread head' };
    }
    if (input.sourceRef && this.queuedInputStoreDir) {
      const inQueue = session.queuedInputs.find((q) => q.sourceRef === input.sourceRef);
      if (inQueue) {
        return {
          success: true,
          delivery: 'queued',
          id: inQueue.id,
          queueLength: session.queuedInputs.length,
          duplicate: true,
          ...(input.source ? { source: input.source } : {}),
          ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        };
      }
      const { consumedSourceRefs } = this.loadQueuedInputState(agentId);
      if (consumedSourceRefs.includes(input.sourceRef)) {
        return {
          success: true,
          delivery: 'consumed',
          duplicate: true,
          ...(input.source ? { source: input.source } : {}),
          ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        };
      }
    }

    if (!isNonUserTurn && lease && !input.commandIdentity) {
      const requestId = lease.requestId;
      const response = this.createTextInputResponse(input);
      if (!this.forwardInputResponse(agentId, session, requestId, input.text, response)) {
        return {
          success: false,
          code: 'runtime_not_accepting_input',
          error: 'Agent runtime is not connected',
        };
      }
      delete session.inputLease;
      this.emitSessionEvent({ kind: 'input-requests', agentId });
      return {
        success: true,
        delivery: 'input',
        requestId,
        ...(input.source ? { source: input.source } : {}),
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      };
    }

    // 这是 runtime 的会话邮箱，不依赖 callActive。它承接新建/恢复会话中
    // “前端已可编辑、输入循环尚未开放 lease”这一正常启动阶段的首条消息。
    // 邮箱封禁（inputPolicy 'none'）只拒绝排队注入；feature 驱动的输入租约
    // 不受影响，仍可正常回复。
    if (session.inputPolicy === 'none') {
      return {
        success: false,
        code: 'runtime_not_accepting_input',
        error: 'This runtime does not accept external user turns',
      };
    }
    // 接收端幂等去重（ADR-0047 阶段 3a）：带 sourceRef 的重复投递不重复
    // 入队——投递方在标记 delivered 前崩溃重试、或消费回执丢失后重试，
    // 同一 commandId 幂等返回。两层：未消费（队列内，含重启恢复的持久
    // 队列）返回既有排队项；已消费返回幂等成功（不重新执行）。无
    // sourceRef 的输入（前端直发用户消息）不去重，保持原语义。
    if (input.commandIdentity && !this.queuedInputStoreDir) {
      return {
        success: false,
        code: 'persistent_store_unavailable',
        error: 'WorkThread commands require a durable Viewer input store',
        retryable: true,
      };
    }
    if (input.commandIdentity && (session.threadId !== input.commandIdentity.threadId
      || session.headGeneration !== input.commandIdentity.headGeneration
      || !input.sessionId)) {
      return { success: false, code: 'runtime_not_accepting_input', error: 'Command identity does not match the registered WorkThread head' };
    }
    const queuedInput = this.enqueueQueuedInput(agentId, session, input.text, input.images, input.source, input.sourceRef, input.capabilityActivations, input.metadata, input.kind, input.sessionId, input.commandIdentity);
    if (!queuedInput) {
      // 持久接管失败 = 未接收：可重试失败，内存与磁盘均未入队。
      return {
        success: false,
        code: 'persistent_store_unavailable',
        error: 'Queued input store unavailable; retry delivery',
        retryable: true,
      };
    }
    this.emitSessionEvent({ kind: 'queued-inputs', agentId });
    console.log(`[Viewer Worker] 用户回合已排队: ${agentId}, source=${input.source || 'unknown'}, queueLength=${session.queuedInputs.length}`);
    return {
      success: true,
      delivery: 'queued',
      id: queuedInput.id,
      queueLength: session.queuedInputs.length,
      ...(input.source ? { source: input.source } : {}),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    };
  }

  private handlePostUserTurn(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const result = this.submitUserTurn(agentId, JSON.parse(body) as UserTurnInput);
        const status = result.success
          ? 200
          : result.code === 'agent_not_found'
            ? 404
            : result.code === 'input_mode_conflict' || result.code === 'runtime_not_accepting_input'
              ? 409
              : result.code === 'persistent_store_unavailable'
                ? 503
                : 400;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, code: 'invalid_input', error: 'Invalid request' }));
      }
    });
  }

  private forwardInputResponse(
    agentId: string,
    session: AgentSession,
    requestId: string,
    input: string,
    response: UserInputResponse,
  ): boolean {
    const message = JSON.stringify({
      type: 'input-response',
      agentId,
      requestId,
      input: response.text ?? input ?? '',
      response,
    }) + '\n';

    const targetClientId = session.clientId;
    if (targetClientId) {
      const targetSocket = this.udsClients.get(targetClientId);
      if (targetSocket) {
        try {
          targetSocket.write(message);
          console.log(`[Viewer Worker] 输入响应已发送到 ${targetClientId}: ${requestId}`);
          return true;
        } catch (writeError) {
          console.error('[Viewer Worker] UDS 写入失败:', writeError);
          return false;
        }
      } else {
        console.warn(`[Viewer Worker] 目标客户端连接不存在: ${targetClientId}`);
      }
      return false;
    }

    // Runtime-scoped input must have an exact client binding. Broadcasting would
    // allow a missing/stale runtime identity to deliver input to another agent.
    console.warn(`[Viewer Worker] Agent has no clientId; refusing input delivery: ${agentId}`);
    return false;
  }

  private createTextInputResponse(input: UserTurnInput | QueuedInput): UserInputResponse {
    const payload: Record<string, unknown> = {};
    if (Array.isArray(input.images) && input.images.length > 0) payload.images = input.images;
    if (input.source) payload.source = input.source;
    if (input.sourceRef) payload.sourceRef = input.sourceRef;
    if (Array.isArray(input.capabilityActivations) && input.capabilityActivations.length > 0) {
      payload.capabilityActivations = input.capabilityActivations;
    }
    if (input.metadata && typeof input.metadata === 'object' && Object.keys(input.metadata).length > 0) {
      payload.metadata = input.metadata;
    }
    return {
      kind: 'text',
      text: input.text,
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    };
  }

  // ── 排队输入持久接管（ADR-0047 阶段 3a）────────────────────────────
  //
  // 文件布局：<dir>/queued-inputs/<safe(agentId)>.json
  //   { version: 1, items: QueuedInput[], consumedSourceRefs: string[] }
  // 原子写（tmp + rename）；损坏文件按空队列处理并保留 .corrupt 取证副本。
  // consumedSourceRefs 保留最近 500 条，仅用于旧 sourceRef 输入的兼容去重。
  // WorkThread commandIdentity 走持久 inputLease/ack 状态，不依赖该有界集合。
  private static readonly CONSUMED_REF_CAP = 500;

  /** Claim one durable WorkThread command without removing it from the queue. */
  public claimCommandInput(agentId: string): QueuedInput | null {
    const session = this.agentSessions.get(agentId);
    const input = session?.queuedInputs?.[0];
    if (!session || !input?.commandIdentity) return null;
    const identity = session.runtimeInstanceId && session.threadId && session.workSessionId && Number.isInteger(session.headGeneration)
      ? {
          ...input.commandIdentity,
          leaseId: input.inputLease?.leaseId || randomUUID(),
          sessionId: session.workSessionId,
          runtimeInstanceId: session.runtimeInstanceId,
        }
      : null;
    if (!identity || identity.threadId !== session.threadId || identity.headGeneration !== session.headGeneration) return null;
    const previous = input.inputLease;
    if (previous && (previous.runtimeInstanceId !== identity.runtimeInstanceId
      || previous.headGeneration !== identity.headGeneration
      || previous.sessionId !== identity.sessionId)) {
      identity.leaseId = randomUUID();
    }
    const persistedItems = session.queuedInputs.map((item) => item === input ? { ...item, inputLease: identity } : item);
    const { consumedSourceRefs } = this.loadQueuedInputState(agentId);
    if (!this.saveQueuedInputState(agentId, persistedItems, consumedSourceRefs)) return null;
    input.inputLease = identity;
    return structuredClone(input);
  }

  /** Acknowledge only the exact persisted lease currently owned by this runtime/head. */
  public acknowledgeCommandInput(agentId: string, receipt: QueuedInput['inputLease']): boolean {
    if (!receipt) return false;
    const session = this.agentSessions.get(agentId);
    if (!session || session.runtimeInstanceId !== receipt.runtimeInstanceId
      || session.threadId !== receipt.threadId || session.headGeneration !== receipt.headGeneration) return false;
    const index = session.queuedInputs.findIndex((item) => item.commandIdentity?.commandId === receipt.commandId
      && item.inputLease?.leaseId === receipt.leaseId
      && item.inputLease?.sessionId === receipt.sessionId
      && item.inputLease?.runtimeInstanceId === receipt.runtimeInstanceId
      && item.inputLease?.headGeneration === receipt.headGeneration);
    if (index < 0) {
      // 重复 ack 幂等（ADR-0047 阶段 3b）：ack 成功但响应丢失后重试，条目已
      // 移除。持久模式以磁盘消费集判定（重启后仍幂等）；内存模式以会话内
      // 已 ack 集合判定。两者都未命中才是真正的身份不符（409）。
      if (this.queuedInputStoreDir
        && this.loadQueuedInputState(agentId).consumedSourceRefs.includes(receipt.commandId)) return true;
      return this.consumedCommandAcks.get(agentId)?.has(receipt.commandId) === true;
    }
    const next = [...session.queuedInputs];
    next.splice(index, 1);
    const { consumedSourceRefs } = this.loadQueuedInputState(agentId);
    if (this.queuedInputStoreDir) {
      // ack 即消费确认（该输入已随会话快照持久进入上下文，不同于转交前的
      // 预写）：与队列移除同一次原子写记入有界消费集——重复 ack 幂等成功；
      // 同 commandId 重投（投递响应丢失 + 已 claim/ack 的窗口）在提交面
      // 两层去重命中 delivery:'consumed'，不重新入队二次执行。
      const nextRefs = consumedSourceRefs.includes(receipt.commandId)
        ? consumedSourceRefs
        : [...consumedSourceRefs, receipt.commandId].slice(-ViewerWorker.CONSUMED_REF_CAP);
      if (!this.saveQueuedInputState(agentId, next, nextRefs)) return false;
    }
    session.queuedInputs.splice(index, 1);
    const acked = this.consumedCommandAcks.get(agentId) ?? new Set<string>();
    acked.add(receipt.commandId);
    if (acked.size > ViewerWorker.CONSUMED_REF_CAP) {
      for (const id of acked) {
        acked.delete(id);
        break;
      }
    }
    this.consumedCommandAcks.set(agentId, acked);
    this.emitSessionEvent({ kind: 'queued-inputs', agentId });
    return true;
  }

  private queuedInputStoreFile(agentId: string): string | null {
    if (!this.queuedInputStoreDir) return null;
    // encodeURIComponent 是单射编码：不同 agentId 不会折叠为同一文件名
    // （审查裁定：`_` 替换可能让 `a/b` 与 `a_b` 碰撞）。
    const safe = encodeURIComponent(agentId);
    return join(this.queuedInputStoreDir, 'queued-inputs', `${safe}.json`);
  }

  private loadQueuedInputState(agentId: string): { items: QueuedInput[]; consumedSourceRefs: string[] } {
    const file = this.queuedInputStoreFile(agentId);
    if (!file || !existsSync(file)) return { items: [], consumedSourceRefs: [] };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const items = Array.isArray(parsed?.items) ? parsed.items.filter((x: unknown) => x && typeof x === 'object') : [];
      const refs = Array.isArray(parsed?.consumedSourceRefs)
        ? parsed.consumedSourceRefs.filter((x: unknown): x is string => typeof x === 'string')
        : [];
      return { items, consumedSourceRefs: refs };
    } catch (error) {
      // 损坏不炸 worker：隔离取证副本，按空状态继续（下次写覆盖）。
      try { renameSync(file, `${file}.corrupt`); } catch { /* 并发隔离失败可容忍 */ }
      console.warn(`[Viewer Worker] 排队输入持久文件损坏，已隔离并重置: ${file}`, error);
      return { items: [], consumedSourceRefs: [] };
    }
  }

  /** @returns 持久化是否成功。无 storeDir 时返回 true（内存语义无磁盘承诺）。 */
  private saveQueuedInputState(agentId: string, items: QueuedInput[], consumedSourceRefs: string[]): boolean {
    const file = this.queuedInputStoreFile(agentId);
    if (!file) return true;
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, items, consumedSourceRefs }));
      renameSync(tmp, file);
      return true;
    } catch (error) {
      // 持久接管承诺下，写盘失败必须信号化（ADR-0047 阶段 3a 审查裁定）：
      // 接收方返回失败让投递方重试，而不是静默 success 后在崩溃中丢输入。
      console.error('[Viewer Worker] 排队输入持久化失败:', error);
      return false;
    }
  }

  /**
   * 移除预写（ADR-0047 阶段 3a 二轮审查裁定）：把「移除 consumed 后的
   * 队列」写入磁盘，**不记消费引用**。调用方在写成功后才从内存移除并
   * 转交；消费引用由 `recordConsumedRef` 在转交/响应成功后补记。
   *
   * 为什么不预记引用：预写（移除+记引用）成功后若转交失败且补救写也
   * 失败（或预写后立即崩溃），磁盘记录「已消费」会挡住重投（去重返回
   * consumed 不重新入队）——形成丢且不可重发。只移除不记引用后，任何
   * 转交前/转交失败路径的重投都能重新入队：重复执行是可见的（turn
   * 事件链留痕），静默丢失不可见——ADR-0047 的一贯取舍。
   *
   * @returns 写盘是否成功；无 storeDir 返回 true（内存语义无磁盘承诺）。
   */
  private persistRemoveQueuedInput(agentId: string, nextItems: QueuedInput[]): boolean {
    if (!this.queuedInputStoreDir) return true;
    const { consumedSourceRefs } = this.loadQueuedInputState(agentId);
    return this.saveQueuedInputState(agentId, nextItems, consumedSourceRefs);
  }

  /**
   * 转交/响应成功后补记消费引用（接收端去重防护窗口）。失败仅告警：
   * items 已移除，引用未记只让后续重投重新入队（可见的重复），不产生
   * 丢失。有界窗口（CONSUMED_REF_CAP）语义见去重检查处注释。
   */
  private recordConsumedRef(agentId: string, sourceRef?: string): void {
    if (!this.queuedInputStoreDir || !sourceRef) return;
    const { items, consumedSourceRefs } = this.loadQueuedInputState(agentId);
    if (consumedSourceRefs.includes(sourceRef)) return;
    consumedSourceRefs.push(sourceRef);
    if (consumedSourceRefs.length > ViewerWorker.CONSUMED_REF_CAP) {
      consumedSourceRefs.splice(0, consumedSourceRefs.length - ViewerWorker.CONSUMED_REF_CAP);
    }
    if (!this.saveQueuedInputState(agentId, items, consumedSourceRefs)) {
      console.warn(`[Viewer Worker] 消费引用补记失败（重投将重新入队，不丢失）: agentId=${agentId}`);
    }
  }

  private enqueueQueuedInput(
    agentId: string,
    session: AgentSession,
    text: string,
    images?: ImageInput[],
    source?: string,
    sourceRef?: string,
    capabilityActivations?: string[],
    metadata?: Record<string, unknown>,
    kind?: TurnKind,
    sessionId?: string,
    commandIdentity?: QueuedInput['commandIdentity'],
  ): QueuedInput | null {
    if (!session.queuedInputs) {
      (session as any).queuedInputs = [];
    }
    const queuedInput: QueuedInput = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text,
      timestamp: Date.now(),
      // kind 随排队项落地：reminder 供消费端落 system 消息，resume 供
      // react-loop 空启动分支识别；省略即 user。
      ...(kind === 'reminder' || kind === 'resume' ? { kind } : {}),
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
      ...(source ? { source } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(commandIdentity ? { commandIdentity } : {}),
      // 会话归属事实（ADR-0019 决策 8）：排队项随行，dequeue 消费端可见。
      ...(sessionId ? { sessionId } : {}),
      ...(Array.isArray(capabilityActivations) && capabilityActivations.length > 0 ? { capabilityActivations } : {}),
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
    session.queuedInputs.push(queuedInput);
    if (this.queuedInputStoreDir) {
      const { consumedSourceRefs } = this.loadQueuedInputState(agentId);
      if (!this.saveQueuedInputState(agentId, [...session.queuedInputs], consumedSourceRefs)) {
        // 接收边界收敛规则：持久接管失败 = 未接收。回滚内存保持两层
        // 一致，返回失败让投递方重试；不能静默 success（崩溃丢输入）。
        session.queuedInputs.pop();
        return null;
      }
    }
    return queuedInput;
  }

  /**
   * 获取排队中的用户输入
   */
  private handleGetQueuedInputs(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const queued = this.getQueuedInputsSnapshot(agentId)!;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(queued));
  }

  /**
   * 消费第一条排队消息（严格 FIFO，含携带 user-turn metadata 的项）。
   *
   * call 内注入（react-loop）现在经 dispatchTurnMetadata 在注入点派发
   * metadata，排队项无需再按 metadata 分流——跳过分流会颠倒用户消息
   * 顺序（后发的普通消息先被消费），FIFO 是唯一正确语义。
   */
  private handleDequeueInput(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    // 请求可能带 body（历史调用方曾发送 { skipMetadata }）：读掉再响应，
    // 避免 keep-alive 连接上未读 body 干扰后续请求解析
    req.resume?.();

    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const queued = session.queuedInputs || [];
    if (queued.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ input: null }));
      return;
    }

    const input = queued[0];
    // WorkThread commands are consumed only through durable claim/ack. Legacy
    // dequeue callers (React drain / CallArbiter safety net) must not remove one
    // before the runtime has persisted its receipt-bearing session snapshot.
    if (input.commandIdentity) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ input: null, remaining: queued.length }));
      return;
    }
    // 消费边界收敛：先把移除预写成功，才动内存并转交；写失败 → 输入
    // 保留未消费，503 让 runtime 下轮再取。消费引用在响应成功后补记
    // （recordConsumedRef）——预记引用会在「预写成功+响应前崩溃+重投」
    // 窗口挡住重试造成丢失。
    if (!this.persistRemoveQueuedInput(agentId, queued.slice(1))) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: 'Queued input store unavailable', retryable: true }));
      return;
    }
    queued.shift();
    console.log(`[Viewer Worker] 消费排队输入: ${agentId}, remaining=${queued.length}`);
    this.emitSessionEvent({ kind: 'queued-inputs', agentId });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ input, remaining: queued.length }));
    this.recordConsumedRef(agentId, input.sourceRef);
  }

  /**
   * 中断正在运行的 Agent
   */
  private handleInterrupt(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    console.log(`[VW.handleInterrupt] agentId=${agentId}, sessionFound=${!!session}, sessionKeys=[${[...this.agentSessions.keys()].join(',')}]`);
    if (!session) {
      console.log(`[VW.handleInterrupt] 404 - agent not found in sessions`);
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    // 通过 UDS 发送中断消息到 Agent 进程
    const targetClientId = session.clientId;
    console.log(`[VW.handleInterrupt] session.clientId=${targetClientId}, udsClientKeys=[${[...this.udsClients.keys()].join(',')}]`);
    if (targetClientId) {
      const targetSocket = this.udsClients.get(targetClientId);
      console.log(`[VW.handleInterrupt] socketFound=${!!targetSocket}, socketDestroyed=${targetSocket?.destroyed}`);
      if (!targetSocket) {
        console.warn(`[VW.handleInterrupt] no UDS socket for clientId=${targetClientId}`);
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: false,
          code: 'runtime_not_accepting_input',
          error: 'Agent runtime is not connected',
        }));
        return;
      }
      try {
        if (Array.isArray(session.queuedInputs) && session.queuedInputs.length > 0) {
          // 用户显式中断 = 放弃排队项（不是消费）：持久队列同步清空，
          // 但不记 consumedSourceRefs——同 commandId 重投是新的投递意图。
          // 取舍：中断优先于存储（不能被 store 故障劫持），写盘失败仅告警
          // ——重启后这些被放弃的项会恢复入队，由下一次中断或人工清理；
          // 这是显式接受的窄风险，不是静默降级。
          if (this.queuedInputStoreDir) {
            const { consumedSourceRefs } = this.loadQueuedInputState(agentId);
            this.saveQueuedInputState(agentId, [], consumedSourceRefs);
          }
          session.queuedInputs = [];
        }
        targetSocket.write(JSON.stringify({
          type: 'interrupt-agent',
          agentId,
          clearQueue: true,
        }) + '\n');
        console.log(`[VW.handleInterrupt] UDS message sent to ${targetClientId}: ${agentId}`);
      } catch (writeError) {
        console.error('[VW.handleInterrupt] UDS write failed:', writeError);
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: false,
          code: 'runtime_not_accepting_input',
          error: 'Agent runtime is not connected',
        }));
        return;
      }
    } else {
      console.warn(`[VW.handleInterrupt] session has no clientId`);
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false,
        code: 'runtime_not_accepting_input',
        error: 'Agent runtime is not connected',
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * 请求 Agent runtime 优雅停止（外部 runtime 生命周期通道，ADR-0037 决策 4）。
   * 与 interrupt 同一连接下发通路（UDS / TCP 认证客户端共用 clientId 注册表），
   * 只回报受理结果；停止完成以连接断开与会话状态为准。
   */
  private handleStopAgent(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    // 停止请求不带 body；读掉可能的空 body，避免 keep-alive 连接解析错位。
    req.resume?.();

    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    const targetClientId = session.clientId;
    const targetSocket = targetClientId ? this.udsClients.get(targetClientId) : null;
    if (!targetSocket) {
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false,
        code: 'runtime_not_accepting_input',
        error: 'Agent runtime is not connected',
      }));
      return;
    }

    try {
      targetSocket.write(JSON.stringify({ type: 'stop-agent', agentId }) + '\n');
      console.log(`[Viewer Worker] stop-agent 已下发: agentId=${agentId}, clientId=${targetClientId}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (writeError) {
      console.error('[Viewer Worker] stop-agent 下发失败:', writeError);
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false,
        code: 'runtime_not_accepting_input',
        error: 'Agent runtime is not connected',
      }));
    }
  }

  /**
   * 宿主定向请求（host-request 通道，与 stop-agent 同一连接下发通路）：
   * body 透传给 runtime 侧注册的 host request 回调，响应经 host-response
   * 帧回传后以 200 返回。payload 对 viewer 不透明，语义归宿主与 runtime。
   * 超时（默认 30s，AGENTDEV_HOST_REQUEST_TIMEOUT_MS 可覆盖）与连接断开
   * 都会终结在途请求，不让 HTTP 调用方悬挂。
   */
  private handleHostRequest(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      let payload: unknown;
      try {
        payload = body.trim() ? JSON.parse(body) : undefined;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, code: 'invalid_json', error: 'Invalid JSON body' }));
        return;
      }
      const session = this.agentSessions.get(agentId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }
      const targetClientId = session.clientId;
      const targetSocket = targetClientId ? this.udsClients.get(targetClientId) : null;
      if (!targetClientId || !targetSocket) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: false,
          code: 'runtime_not_accepting_input',
          error: 'Agent runtime is not connected',
        }));
        return;
      }

      void this.sendHostRequestToAgent(agentId, targetClientId, targetSocket, payload).then((response) => {
        if (response === null) {
          res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, code: 'host_request_timeout', error: 'Runtime did not respond in time' }));
          return;
        }
        if (response.error !== undefined) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, code: 'host_request_failed', error: response.error }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, result: response.result ?? null }));
      });
    });
  }

  /**
   * host-request 下发核心（供 HTTP 端点与 /res/ 资产回源共用）：向目标
   * runtime 连接写入 host-request 帧，pendings 关联 host-response 回传。
   * resolve(null) = 超时；{error} = 断连被按 clientId 批量失败或 runtime 报错。
   */
  private sendHostRequestToAgent(
    agentId: string,
    clientId: string,
    socket: Socket,
    payload: unknown,
  ): Promise<{ result?: unknown; error?: string } | null> {
    const requestId = randomUUID();
    const timeoutMs = Math.max(1, Number(process.env.AGENTDEV_HOST_REQUEST_TIMEOUT_MS) || 30_000);
    // null = 超时标记（断连走 error 形态，二者都以同一 promise 收口）
    const responsePromise = new Promise<{ result?: unknown; error?: string } | null>((resolve) => {
      const timer = setTimeout(() => {
        this.hostRequestPendings.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.hostRequestPendings.set(requestId, {
        clientId,
        timer,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
      });
    });
    try {
      socket.write(JSON.stringify({ type: 'host-request', requestId, agentId, payload }) + '\n');
      console.log(`[Viewer Worker] host-request 已下发: agentId=${agentId}, requestId=${requestId}, clientId=${clientId}`);
    } catch (writeError) {
      console.error('[Viewer Worker] host-request 下发失败:', writeError);
      const pending = this.hostRequestPendings.get(requestId);
      if (pending) {
        this.hostRequestPendings.delete(requestId);
        clearTimeout(pending.timer);
      }
      return Promise.resolve({ error: 'Agent runtime is not connected' });
    }
    return responsePromise;
  }

  /** 按连接失败在途 host-request（socket close/error 时调用）。 */
  private failHostRequestsByClient(clientId: string): void {
    for (const [requestId, pending] of this.hostRequestPendings) {
      if (pending.clientId !== clientId) continue;
      this.hostRequestPendings.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ error: 'Runtime connection closed' });
    }
  }

  /**
   * 查询 Agent 是否正在运行
   */
  private handleGetRunning(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    // 通过 UDS 查询运行状态
    const targetClientId = session.clientId;
    if (targetClientId) {
      const targetSocket = this.udsClients.get(targetClientId);
      if (targetSocket) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ running: true }));
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ running: false }));
  }

  // ========== 会话管理 ==========

  /**
   * 获取或创建会话
   */
  public getOrCreateSession(agentId: string, name: string): AgentSession {
    let session = this.agentSessions.get(agentId);
    if (!session) {
      session = {
        id: agentId,
        name,
        messages: [],
        tools: [],
        createdAt: Date.now(),
        lastActive: Date.now(),
        // 通知系统扩展
        currentState: null,
        callActive: false,
        runtimeState: this.createEmptyRuntimeState(),
        events: [],
        lastEventCount: 0,
        logs: [],
        overview: this.createEmptyOverview(),
        todoPlan: this.createEmptyTodoPlan(),
        // 持久接管恢复（ADR-0047 阶段 3a）：worker 重启后排队输入从磁盘
        // 恢复，runtime 重连消费——接收后崩溃不再丢失已接收输入。
        queuedInputs: this.queuedInputStoreDir ? this.loadQueuedInputState(agentId).items : [],
      };
      this.agentSessions.set(agentId, session);
    }
    return session;
  }

  /**
   * 更新会话活跃时间
   */
  public updateSessionActivity(agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (session) {
      session.lastActive = Date.now();
    }
  }

  private isSessionConnected(session: AgentSession): boolean {
    return !!session.clientId && this.udsClients.has(session.clientId);
  }

  // ========== 会话事件总线（宿主推送通道的信号源） ==========

  private sessionEventListeners: Set<ViewerSessionEventListener> = new Set();

  /**
   * 订阅会话事件。返回退订函数。订阅方异常不阻断 worker 主流程。
   */
  public onSessionEvent(listener: ViewerSessionEventListener): () => void {
    this.sessionEventListeners.add(listener);
    return () => {
      this.sessionEventListeners.delete(listener);
    };
  }

  /**
   * 启动探测：旧框架/无订阅 API 时宿主据此整体关闭推送特性。
   */
  public hasSessionEventListeners(): boolean {
    return this.sessionEventListeners.size > 0;
  }

  private emitSessionEvent(event: ViewerSessionEvent): void {
    if (this.sessionEventListeners.size === 0) return;
    for (const listener of this.sessionEventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[Viewer Worker] 会话事件监听器异常:', err);
      }
    }
  }

  /**
   * UDS 连接断开时反查受影响 agent 并发 connection 事件。一个连接可承载
   * 多个 session（register 时各自记录 clientId），必须遍历求全集。
   */
  private emitDisconnectedByClientId(clientId: string): void {
    this.failHostRequestsByClient(clientId);
    for (const [agentId, session] of this.agentSessions) {
      if (session.clientId === clientId) {
        this.emitSessionEvent({ kind: 'connection', agentId, connected: false, reconnected: false });
      }
    }
  }

  // ========== 会话快照（事件订阅方与 GET 端点共用的组装单点） ==========
  // 事件路径与轮询路径永远同构：GET handler 与订阅方都从这里取数。

  /**
   * 与 GET /notification 响应体同构（不含 hasNewEvents——那是 GET 的读即
   * 对齐语义，事件模式下无意义）。agent 不存在时返回 null，订阅方跳过。
   */
  public getNotificationSnapshot(agentId: string): {
    state: AgentSession['currentState'];
    event: AgentSession['events'][number] | null;
    runtime: AgentRuntimeStateSnapshot;
    callActive: boolean;
  } | null {
    const session = this.agentSessions.get(agentId);
    if (!session) return null;
    return {
      state: session.currentState,
      event: session.events.length > 0 ? session.events[session.events.length - 1] : null,
      runtime: this.cloneRuntimeState(this.getSessionRuntimeState(session)),
      callActive: session.callActive === true,
    };
  }

  /**
   * 与 GET /overview 响应体同构（含 _messagesProbe，探测不可用时字段缺省）。
   */
  public getOverviewSnapshot(agentId: string): (AgentOverviewSnapshot & { _messagesProbe?: MessagesProbe }) | null {
    const session = this.agentSessions.get(agentId);
    if (!session) return null;
    const overview = this.getMergedOverview(session);
    const probe = this.getMessagesProbe(session);
    return probe ? { ...overview, _messagesProbe: probe } : overview;
  }

  /** 与 GET /todo 响应体同构。 */
  public getTodoSnapshot(agentId: string): TodoPlanSnapshot | null {
    const session = this.agentSessions.get(agentId);
    if (!session) return null;
    return session.todoPlan ?? this.createEmptyTodoPlan();
  }

  /** 与 GET /input-requests 响应体同构（覆盖式唯一 lease）。 */
  public getInputRequestsSnapshot(agentId: string): InputLease[] | null {
    const session = this.agentSessions.get(agentId);
    if (!session) return null;
    const lease = session.inputLease;
    return lease ? [{ ...lease }] : [];
  }

  /** 与 GET /queued-inputs 响应体同构（浅拷贝，数组结构快照）。 */
  public getQueuedInputsSnapshot(agentId: string): QueuedInput[] | null {
    const session = this.agentSessions.get(agentId);
    if (!session) return null;
    return [...(session.queuedInputs || [])];
  }

  /** agent 不存在时返回 null（区别于存在但未连接的 false）。 */
  public isAgentConnected(agentId: string): boolean | null {
    const session = this.agentSessions.get(agentId);
    if (!session) return null;
    return this.isSessionConnected(session);
  }

  /**
   * 已注册 agent 的轻量清单（id/name/connected），供宿主推送通道做
   * hello 首连快照（bell 扫描等全量视图）。worker 是注册事实的单一真相，
   * 宿主不另建影子注册表。
   */
  public listAgentStates(): Array<{ id: string; name: string; connected: boolean }> {
    const result: Array<{ id: string; name: string; connected: boolean }> = [];
    for (const session of this.agentSessions.values()) {
      result.push({
        id: session.id,
        name: session.name,
        connected: this.isSessionConnected(session),
      });
    }
    return result;
  }

  /**
   * 应用内存限制
   *
   * 字节限制基于增量缓存 _totalBytes（推送时维护，修剪时扣减）：未超限
   * 零序列化开销；未初始化（旧路径未走过推送）时先全量求和建立基线。
   * 切点语义与原实现一致：超出 MAX_BYTES 时保留首个超限条目之后的尾部。
   */
  public enforceMemoryLimits(session: AgentSession): void {
    const store = session as any;

    // 消息数量限制
    while (session.messages.length > this.MAX_MESSAGES) {
      const removed = session.messages.shift();
      if (typeof store._totalBytes === 'number') {
        store._totalBytes -= JSON.stringify(removed).length;
      }
      if (Array.isArray(store._messageTimestamps) && store._messageTimestamps.length > 0) {
        store._messageTimestamps.shift();
      }
    }

    // 字节限制
    if (typeof store._totalBytes !== 'number') {
      let total = 0;
      for (let i = 0; i < session.messages.length; i++) {
        total += JSON.stringify(session.messages[i]).length;
      }
      store._totalBytes = total;
    }
    if (store._totalBytes > this.MAX_BYTES) {
      let byteSize = 0;
      for (let i = 0; i < session.messages.length; i++) {
        byteSize += JSON.stringify(session.messages[i]).length;
        if (byteSize > this.MAX_BYTES) {
          // 删除超出部分
          session.messages = session.messages.slice(i + 1);
          store._totalBytes -= byteSize;
          if (Array.isArray(store._messageTimestamps)) {
            store._messageTimestamps = store._messageTimestamps.slice(i + 1);
          }
          break;
        }
      }
    }
  }

  // ========== IPC 消息处理 ==========

  /**
   * 处理注册 Agent
   */
  public handleRegisterAgent(msg: any, clientId?: string): void {
    const { agentId, name, projectRoot, resourceRootCount, templateEntries, hookInspector, overview, activeInputRequest, inputPolicy } = msg;
    // 身份字段按 RegisterAgentMsg 契约位于消息顶层（DebugHub UDS 发送端
    // 的展开位置）；msg.metadata 是 Claw HTTP 注册通道（ClawSessionRegistration
    // .metadata）的承载位置，作兜底。只读一处会让另一通道的身份静默丢失，
    // WorkThread fencing 将拒绝一切线程指令（阶段 5 真实宿主联测捕获）。
    const metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
    const identitySource = { ...metadata, ...msg };
    const { runtimeInstanceId, threadId, headGeneration, workSessionId } = identitySource;
    // 重连判定：session 已存在即 UDS 断开后的重新注册（DebugHub 重连
    // reRegisterAgents 全量重推），订阅方据此对该 agent 触发一次对账。
    const isReconnect = this.agentSessions.has(agentId);
    const session = this.getOrCreateSession(agentId, name);

    // Runtime registration is authoritative for durable WorkThread receipt fencing.
    session.runtimeInstanceId = typeof runtimeInstanceId === 'string' ? runtimeInstanceId : undefined;
    session.threadId = typeof threadId === 'string' ? threadId : undefined;
    session.headGeneration = Number.isInteger(headGeneration) ? headGeneration : undefined;
    session.workSessionId = typeof workSessionId === 'string' ? workSessionId : undefined;

    // 外部输入策略（'none' = 拒绝排队注入，如测试沙盒）
    if (inputPolicy === 'none') {
      session.inputPolicy = 'none';
    }

    // 存储项目根目录（用于模板文件加载）
    if (projectRoot) {
      session.projectRoot = projectRoot;
    }

    // 记录所属客户端连接（用于多进程输入响应路由）
    if (clientId) {
      session.clientId = clientId;
    }

    // 收集资源注册载荷（ADR-0038：rootCount + entries，rootId = 0..n-1）。
    // 协议不混版：worker 只认资源根载荷，旧版 mount 载荷一律无视。
    // 根路径不跨进程——文件存在性由 runtime 侧收集时保证，worker 侧缺失
    // 只会在回源 404 时显性化（有日志）。
    if (typeof resourceRootCount === 'number' && templateEntries && typeof templateEntries === 'object') {
      const entries: Record<string, { root: number; rel: string }> = {};
      for (const [templateName, entry] of Object.entries(templateEntries)) {
        const root = (entry as any)?.root;
        const rel = (entry as any)?.rel;
        if (typeof root !== 'number' || !Number.isInteger(root) || root < 0 || root >= resourceRootCount) continue;
        if (typeof rel !== 'string' || !rel) continue;
        entries[templateName] = { root, rel };
      }
      this.templatePayloads.set(agentId, { rootCount: resourceRootCount, entries });
    }

    if (hookInspector) {
      session.hookInspector = hookInspector;
    }
    if (overview) {
      session.overview = overview;
    }

    // call 运行状态对账：agent 进程被关闭时 call.finish 无法送达，session 里
    // 会残留上一个进程的 callActive / activeToolNames / currentState，导致前端
    // 状态条永久停留在"正在执行工具 · X"。重新注册即新进程接管（同一 agentId
    // 只有一个活跃 runtime 进程），注册快照是完整事实来源，这里与下方 inputLease
    // 对账同一原则：旧进程未终结的 call 状态一律作废。例外：注册携带活跃输入
    // 租约说明是同进程重连（call 真实存活，等待用户输入中），运行状态保留。
    const hasResumableInputLease = !!activeInputRequest;
    if (!hasResumableInputLease
      && (session.callActive || (session.runtimeState?.activeToolCount ?? 0) > 0 || session.currentState)) {
      session.callActive = false;
      session.runtimeState = this.createEmptyRuntimeState();
      session.currentState = null;
      console.log(`[Viewer Worker] Agent ${agentId} 重新注册，已作废旧进程遗留的 call 运行状态`);
    }

    // 恢复活跃的输入请求（用于重连后恢复输入框）
    if (activeInputRequest) {
      // 连接重建是状态对账而不是追加：DebugHub 给出的 lease 是这个 Agent
      // 唯一仍有本地 resolver 的输入所有者，旧连接遗留的租约必须被替换。
      session.inputLease = {
        requestId: activeInputRequest.requestId,
        prompt: activeInputRequest.prompt,
        placeholder: activeInputRequest.placeholder,
        initialValue: activeInputRequest.initialValue,
        actions: activeInputRequest.actions,
        mode: activeInputRequest.mode,
        questions: activeInputRequest.questions,
        timestamp: activeInputRequest.timestamp,
      };

      console.log(`[Viewer Worker] 恢复活跃输入请求: ${activeInputRequest.requestId}，Agent: ${agentId}`);
    } else {
      // 注册快照是完整事实来源；没有 lease 就不能保留旧连接的输入卡。
      delete session.inputLease;
    }

    console.log(`[Viewer Worker] Agent 已注册: ${agentId} (${name})${clientId ? ` [client: ${clientId}]` : ''}`);
    this.emitSessionEvent({ kind: 'connection', agentId, connected: true, reconnected: isReconnect });
  }

  public handleUpdateAgentInspector(msg: any): void {
    const { agentId, hookInspector } = msg;
    const session = this.agentSessions.get(agentId);
    if (!session) return;
    session.hookInspector = hookInspector;
    this.updateSessionActivity(agentId);
  }

  public handleUpdateAgentOverview(msg: { agentId: string; overview: AgentOverviewSnapshot }): void {
    const { agentId, overview } = msg;
    const session = this.agentSessions.get(agentId);
    if (!session) return;
    session.overview = {
      ...overview,
      runtime: this.cloneRuntimeState(session.runtimeState || overview.runtime || this.createEmptyRuntimeState()),
    };
    this.updateSessionActivity(agentId);
    this.emitSessionEvent({ kind: 'overview', agentId });
  }

  public handleUpdateTodoPlan(msg: { agentId: string; plan: TodoPlanSnapshot }): void {
    const { agentId, plan } = msg;
    const session = this.agentSessions.get(agentId);
    if (!session) return;
    session.todoPlan = this.normalizeTodoPlan(plan);
    this.updateSessionActivity(agentId);
    this.emitSessionEvent({ kind: 'todo', agentId });
  }

  /**
   * 清空 Feature 资源注册载荷（当 Agent 断开连接时调用）。
   * URL 随 agent 会话失效：断连后 /res/ 请求在会话/连接检查处 404。
   */
  private clearFeatureTemplates(agentId: string): void {
    this.templatePayloads.delete(agentId);
  }

  /**
   * 处理推送消息。
   *
   * 旧版推送只携带 messages，按 full 快照兼容处理。显式 append/tail 推送
   * 必须通过 baseCount + generation 校验；校验失败时保留当前 Viewer 状态，
   * 并等待后续 full 快照重新建立基线，不能把不完整增量拼进会话。
   *
   * `msg.timestamps` 是与 msg.messages 等长对齐的时间元表（毫秒；
   * null = 无时间锚）。wire Message 不携带时间（导出面治理），展示层的
   * 时间需求经该平行表下发；缺失时时间表状态与消息同生命周期地丢弃。
   */
  public handlePushMessages(msg: any): void {
    const { agentId, messages } = msg;
    const session = this.agentSessions.get(agentId);
    if (!session || !Array.isArray(messages)) return;

    const store = session as any;
    const mode = msg.mode ?? 'full';
    const oldMessages = session.messages;
    let nextMessages: any[];
    let nextTimestamps: (number | null)[] | undefined;

    // 与传入 messages 切片等长对齐；缺位/非法值归 null
    const alignTimestamps = (list: any[]): (number | null)[] => {
      if (!Array.isArray(msg.timestamps)) return new Array(list.length).fill(null);
      return Array.from({ length: list.length }, (_, i) => {
        const ts = msg.timestamps[i];
        return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
      });
    };
    // 与当前已存表等长的读回；无表/失配时按全 null 视图
    const readStoredTimestamps = (): (number | null)[] => {
      if (Array.isArray(store._messageTimestamps)
        && store._messageTimestamps.length === oldMessages.length) {
        return store._messageTimestamps;
      }
      return new Array(oldMessages.length).fill(null);
    };

    if (mode === 'full') {
      // full 是自愈边界：即使之前有失配，也用完整快照恢复并清除标记。
      nextMessages = messages;
      nextTimestamps = Array.isArray(msg.timestamps) ? alignTimestamps(messages) : undefined;
      store._messagesNeedsResync = false;
      if (Number.isInteger(msg.generation) && msg.generation >= 0) {
        store._messagesGeneration = msg.generation;
      } else if (typeof store._messagesGeneration !== 'number') {
        // 旧协议没有 generation，使用稳定的初始代际。
        store._messagesGeneration = 0;
      }
    } else {
      const generation = store._messagesGeneration;
      const validGeneration = Number.isInteger(msg.generation) && msg.generation >= 0
        && typeof generation === 'number' && msg.generation === generation;
      const validBaseCount = Number.isInteger(msg.baseCount) && msg.baseCount === oldMessages.length;
      const validMode = mode === 'append' || mode === 'tail';
      const validShape = mode === 'append'
        ? true
        : mode === 'tail' && oldMessages.length > 0 && messages.length === 1;

      if (!validMode || !validGeneration || !validBaseCount || !validShape || store._messagesNeedsResync === true) {
        // 没有请求/响应式 resync 通道时，安全策略是等待下一次 full。
        // 这条状态只影响 Viewer 内存，不伪造 probe 变更。
        store._messagesNeedsResync = true;
        return;
      }

      const headTimestamps = readStoredTimestamps();
      const deltaTimestamps = alignTimestamps(messages);
      if (mode === 'append') {
        nextMessages = [...oldMessages, ...messages];
        nextTimestamps = [...headTimestamps, ...deltaTimestamps];
      } else {
        nextMessages = [...oldMessages.slice(0, -1), messages[0]];
        nextTimestamps = [...headTimestamps.slice(0, -1), deltaTimestamps[0]];
      }
    }

    const change = this.classifyMessagesChange(oldMessages, nextMessages);

    if (change) {
      session.messages = nextMessages;
      if (nextTimestamps) {
        store._messageTimestamps = nextTimestamps;
      } else {
        delete store._messageTimestamps;
      }
      // seq 只在真实变更时递增（ADR-0012 v2）：它是前端对账的同步版本号。
      // no-op 推送不清槽，避免未消费变更被后续相同推送覆盖。
      store._messagesChangeSeq = (typeof store._messagesChangeSeq === 'number' ? store._messagesChangeSeq : 0) + 1;
      this.updateTotalBytes(session, oldMessages, nextMessages, change.changeKind);
      session._lastMessageSig = this.getLastMessageSignature(nextMessages);
      this.updateSessionActivity(agentId);
      // 修剪前先记录条数：数量修剪经 shift() 原地缩短数组，而该数组与
      // 新推送数组同引用，事后比较会失真。
      const preTrimCount = nextMessages.length;
      this.enforceMemoryLimits(session);
      // 修剪会移除前端已持有的历史条目，增量拼接不再安全，统一标成 rewrite。
      const trimmed = session.messages.length < preTrimCount;
      store._messagesChange = {
        changeKind: trimmed ? 'rewrite' : change.changeKind,
        sinceIndex: trimmed ? 0 : change.sinceIndex,
        fakeFullBytes: store._totalBytes,
      };
      // 真实变更才发事件（no-op 推送与 resync 等待分支内存未变，不发信号）。
      // probe 是信号本体：seq 已递增，订阅方据此决定增量取数。
      const probe = this.getMessagesProbe(session);
      if (probe) {
        this.emitSessionEvent({ kind: 'messages', agentId, probe });
      }
    } else if (typeof store._totalBytes !== 'number') {
      // 从未走过真实变更（如旧 runtime 恢复推送相同内容）：probe 整体保持缺省。
    }
  }

  private createEmptyOverview(): AgentOverviewSnapshot {
    return {
      updatedAt: 0,
      context: {
        messageCount: 0,
        charCount: 0,
        toolCallCount: 0,
        turnCount: 0,
      },
      usageStats: {
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        calls: [],
        totalRequests: 0,
        totalCacheHitRequests: 0,
      },
      runtime: this.createEmptyRuntimeState(),
    };
  }

  private createEmptyTodoPlan(): TodoPlanSnapshot {
    return {
      feature: 'todo',
      updatedAt: 0,
      counter: 0,
      tasks: [],
      summary: {
        total: 0,
        pending: 0,
        inProgress: 0,
        completed: 0,
        cancelled: 0,
      },
      interruptTargetId: null,
    };
  }

  private normalizeTodoPlan(plan?: TodoPlanSnapshot | null): TodoPlanSnapshot {
    const fallback = this.createEmptyTodoPlan();
    if (!plan || typeof plan !== 'object') return fallback;
    const normalizeStatus = (status: unknown): TodoTaskSnapshot['status'] => {
      return status === 'in_progress' || status === 'completed' || status === 'deleted'
        ? status
        : 'pending';
    };
    // 与 features/todo 的 TaskKind 校验基准一致（other 是模型侧 kind 必填的
    // 兜底值，数据层合法保留）；非法值清洗为 undefined，
    // 避免损坏数据流向前端（字段透传契约见 viewer-worker-todo-roundtrip 测试）
    const KINDS: readonly string[] = ['investigate', 'design', 'implement', 'fix', 'verify', 'other'];
    const normalizeKind = (kind: unknown): TodoTaskSnapshot['kind'] => {
      return typeof kind === 'string' && KINDS.includes(kind)
        ? (kind as TodoTaskSnapshot['kind'])
        : undefined;
    };
    const tasks = Array.isArray(plan.tasks) ? plan.tasks.map(task => ({
      id: String(task.id ?? ''),
      subject: String(task.subject ?? ''),
      description: String(task.description ?? ''),
      deliver: task.deliver ? String(task.deliver) : undefined,
      kind: normalizeKind(task.kind),
      status: normalizeStatus(task.status),
      metadata: task.metadata && typeof task.metadata === 'object' ? task.metadata : undefined,
      createdAt: typeof task.createdAt === 'number' ? task.createdAt : 0,
      updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0,
    })).filter(task => task.id) : [];
    const summary = plan.summary || fallback.summary;
    return {
      feature: 'todo',
      updatedAt: typeof plan.updatedAt === 'number' ? plan.updatedAt : Date.now(),
      counter: typeof plan.counter === 'number' ? plan.counter : tasks.length,
      tasks,
      summary: {
        total: typeof summary.total === 'number' ? summary.total : tasks.length,
        pending: typeof summary.pending === 'number' ? summary.pending : tasks.filter(t => t.status === 'pending').length,
        inProgress: typeof summary.inProgress === 'number' ? summary.inProgress : tasks.filter(t => t.status === 'in_progress').length,
        completed: typeof summary.completed === 'number' ? summary.completed : tasks.filter(t => t.status === 'completed').length,
        cancelled: typeof summary.cancelled === 'number' ? summary.cancelled : tasks.filter(t => t.status === 'deleted').length,
      },
      interruptTargetId: typeof plan.interruptTargetId === 'string' ? plan.interruptTargetId : null,
    };
  }

  private createEmptyRuntimeState(): AgentRuntimeStateSnapshot {
    return {
      stage: 'idle',
      callActive: false,
      charCount: 0,
      thinkingChars: 0,
      contentChars: 0,
      toolCallCount: 0,
      activeToolNames: [],
      activeToolCount: 0,
      callStartedAt: 0,
      stageStartedAt: 0,
      updatedAt: 0,
      lastErrorType: null,
      lastErrorMessage: null,
      lastOutcome: null,
    };
  }

  private cloneRuntimeState(snapshot?: AgentRuntimeStateSnapshot | null): AgentRuntimeStateSnapshot {
    const source = snapshot || this.createEmptyRuntimeState();
    return {
      ...source,
      activeToolNames: Array.isArray(source.activeToolNames) ? source.activeToolNames.slice() : [],
      streamToolNames: Array.isArray(source.streamToolNames) ? source.streamToolNames.slice() : undefined,
    };
  }

  private getRuntimeStageFromLLMPhase(phase: string): AgentRuntimeStateSnapshot['stage'] {
    if (phase === 'thinking') return 'llm_thinking';
    if (phase === 'content') return 'llm_content';
    if (phase === 'tool_calling') return 'llm_tool_call_building';
    return 'awaiting_runtime';
  }

  private updateRuntimeStage(
    runtimeState: AgentRuntimeStateSnapshot,
    nextStage: AgentRuntimeStateSnapshot['stage'],
    timestamp: number,
  ): AgentRuntimeStateSnapshot {
    const nextTimestamp = timestamp || Date.now();
    return {
      ...runtimeState,
      stage: nextStage,
      stageStartedAt: runtimeState.stage === nextStage
        ? (runtimeState.stageStartedAt || nextTimestamp)
        : nextTimestamp,
      updatedAt: nextTimestamp,
    };
  }

  private getSessionRuntimeState(session: AgentSession): AgentRuntimeStateSnapshot {
    if (!session.runtimeState) {
      session.runtimeState = this.createEmptyRuntimeState();
    }
    return session.runtimeState;
  }

  private getMergedOverview(session: AgentSession): AgentOverviewSnapshot {
    const base = session.overview || this.createEmptyOverview();
    return {
      ...base,
      runtime: this.cloneRuntimeState(this.getSessionRuntimeState(session)),
    };
  }

  /**
   * 变更分类（ADR-0012，推送时刻新旧数组都在手上）：
   * - append：新数组以旧数组为前缀且变长（sinceIndex = 旧数组长度）
   * - tail：条数不变，仅最后一条不同（流式输出）
   * - rewrite：其余（中段替换 / 条数减少，含 count 与末条签名均不变的盲区）
   * 返回 null 表示未变化。
   */
  private classifyMessagesChange(oldMessages: any[], newMessages: any[]): { changeKind: MessageChangeKind; sinceIndex: number } | null {
    const oldLen = oldMessages.length;
    const newLen = newMessages.length;

    if (newLen > oldLen && this.isSameMessagePrefix(oldMessages, newMessages, oldLen)) {
      return { changeKind: 'append', sinceIndex: oldLen };
    }

    if (newLen === oldLen) {
      if (newLen === 0) return null;
      const lastSigChanged =
        this.getLastMessageSignature(newMessages) !== this.getLastMessageSignature(oldMessages);
      // 末条签名不同时前缀只比到倒数第二条：除末条外全等即 tail，中段
      // 也变了是 rewrite；末条签名相同时全量比对，以识别中段盲区
      const prefixLen = lastSigChanged ? newLen - 1 : newLen;
      if (this.isSameMessagePrefix(oldMessages, newMessages, prefixLen)) {
        return lastSigChanged ? { changeKind: 'tail', sinceIndex: newLen - 1 } : null;
      }
      return { changeKind: 'rewrite', sinceIndex: 0 };
    }

    // 条数减少，或条数增加但前缀不同：rollback / compact / 中段替换
    return { changeKind: 'rewrite', sinceIndex: 0 };
  }

  /**
   * 判断两数组前 len 条是否逐条一致：先比引用（运行时对未变化条目通常
   * 复用同一对象），不一致再退回 JSON 全等（消息对象可能被重建）。
   */
  private isSameMessagePrefix(oldMessages: any[], newMessages: any[], len: number): boolean {
    for (let i = 0; i < len; i++) {
      if (oldMessages[i] === newMessages[i]) continue;
      if (JSON.stringify(oldMessages[i]) !== JSON.stringify(newMessages[i])) return false;
    }
    return true;
  }

  /**
   * 消息探测数据（/overview HTTP 组装用，ADR-0012）。count 取当前消息数，
   * 其余为最近一次推送记录下的分类与假想全量字节；未走过推送路径
   * （_totalBytes 未初始化）时返回 null，调用方据此整体省略 _messagesProbe。
   */
  private getMessagesProbe(session: AgentSession): MessagesProbe | null {
    const change = (session as any)._messagesChange as
      | { changeKind: MessageChangeKind | null; sinceIndex: number | null; fakeFullBytes: number }
      | undefined;
    if (!change || typeof (session as any)._totalBytes !== 'number') return null;
    return {
      seq: (session as any)._messagesChangeSeq || 0,
      count: session.messages.length,
      changeKind: change.changeKind,
      sinceIndex: change.sinceIndex,
      fakeFullBytes: change.fakeFullBytes,
    };
  }

  /**
   * 增量维护 session 总字节缓存（_totalBytes = 全量响应体假想字节数）：
   * append 只序列化新增条目，tail 只序列化末条新旧两份；rewrite（rollback /
   * compact 等低频路径）与未初始化基线时全量重建。
   */
  private updateTotalBytes(session: AgentSession, oldMessages: any[], newMessages: any[], changeKind: MessageChangeKind): void {
    const store = session as any;
    if (typeof store._totalBytes !== 'number' || changeKind === 'rewrite') {
      let total = 0;
      for (let i = 0; i < newMessages.length; i++) {
        total += JSON.stringify(newMessages[i]).length;
      }
      store._totalBytes = total;
      return;
    }
    if (changeKind === 'append') {
      for (let i = oldMessages.length; i < newMessages.length; i++) {
        store._totalBytes += JSON.stringify(newMessages[i]).length;
      }
      return;
    }
    // tail：末条被改写，减旧加新
    store._totalBytes +=
      JSON.stringify(newMessages[newMessages.length - 1]).length -
      JSON.stringify(oldMessages[oldMessages.length - 1]).length;
  }

  /**
   * 获取最后一条消息的签名（用于变化检测）
   *
   * 使用消息的 role、content 和 toolCalls 生成签名
   */
  private getLastMessageSignature(messages: any[]): string {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return '';

    // 图片附件也属于消息内容：工具文本已经入队、图片随结果后到时，
    // 仅比较文本会把附件更新吞掉，前端直到下一条消息都收不到 probe。
    const sig = {
      r: lastMsg.role,
      c: lastMsg.content,
      i: lastMsg.images,
      // 工具调用只比较数量和名称（因为 toolCalls 可能包含动态 ID）
      tc: lastMsg.toolCalls?.map((tc: any) => ({ n: tc.name, a: tc.arguments }))
    };

    return JSON.stringify(sig);
  }

  /**
   * 处理注册工具
   */
  public handleRegisterTools(msg: any): void {
    const { agentId, tools } = msg;
    const session = this.agentSessions.get(agentId);
    if (session) {
      session.tools = [];
      for (const tool of tools) {
        const config = getToolRenderConfig(tool.name, tool.render);
        const callTemplate = config.call || 'json';
        const resultTemplate = config.result || 'json';

        // 检查是否为内联模板（对象类型）
        const callIsInline = typeof tool.render?.call === 'object' && tool.render.call !== null;
        const resultIsInline = typeof tool.render?.result === 'object' && tool.render.result !== null;

        session.tools.push({
          name: tool.name,
          description: tool.description,
          render: {
            call: callIsInline ? '__inline__' : callTemplate,
            result: resultIsInline ? '__inline__' : resultTemplate,
            inlineCall: callIsInline ? tool.render.call : undefined,
            inlineResult: resultIsInline ? tool.render.result : undefined,
          },
        });

        if (!TOOL_DISPLAY_NAMES[tool.name]) {
          (TOOL_DISPLAY_NAMES as Record<string, string>)[tool.name] = tool.name;
        }
      }
      console.log(`[Viewer Worker] Agent ${agentId} 已注册 ${tools.length} 个工具`);
    }
  }

  /**
   * 处理注销 Agent
   */
  public handleUnregisterAgent(msg: any): void {
    const { agentId } = msg;
    this.agentSessions.delete(agentId);
    this.clearFeatureTemplates(agentId);
    console.log(`[Viewer Worker] Agent 已注销: ${agentId}`);
    this.emitSessionEvent({ kind: 'connection', agentId, connected: false, reconnected: false });
  }

  /**
   * 处理停止
   */
  public handleStop(): void {
    process.exit(0);
  }

  /**
   * 处理推送通知
   */
  public handlePushNotification(msg: any): void {
    const { agentId, notification } = msg;
    const session = this.agentSessions.get(agentId);
    if (!session) {
      return;
    }

    this.updateSessionActivity(agentId);

    if (notification?.type === 'log.entry' && notification?.data) {
      session.logs.push(this.normalizeLogEntry(notification.data, session));
      if (session.logs.length > this.MAX_LOGS) {
        session.logs.splice(0, session.logs.length - this.MAX_LOGS);
      }
      return;
    }

    const runtimeState = this.getSessionRuntimeState(session);

    // call 运行状态追踪（独立字段，不受 state 覆盖影响）
    if (notification.type === 'call.start') {
      session.callActive = true;
      const nextStage = runtimeState.activeToolCount > 0 ? 'tool_executing' : 'awaiting_runtime';
      session.runtimeState = {
        ...this.updateRuntimeStage(runtimeState, nextStage, notification.timestamp || Date.now()),
        callActive: true,
        callStartedAt: runtimeState.callActive === true
          ? (runtimeState.callStartedAt || notification.timestamp || Date.now())
          : (notification.timestamp || Date.now()),
        lastErrorType: null,
        lastErrorMessage: null,
        streamToolNames: undefined,
      };
    } else if (notification.type === 'call.finish') {
      // 结构化终态（CallOutcome）：status/reason/error 由框架产出，
      // 不再从文本推断；lastError* 与 lastOutcome 一并进入 runtime snapshot。
      const outcome = (notification.data && typeof notification.data === 'object')
        ? notification.data as {
            status?: string;
            reason?: string;
            error?: { category?: string; message?: string } | null;
          }
        : {};
      const status = typeof outcome.status === 'string' ? outcome.status : '';
      const completed = status === 'completed';
      const cancelled = status === 'cancelled' || status === 'continued';
      const nextStage = completed
        ? 'completed'
        : cancelled
          ? 'cancelled'
          : 'failed';
      session.callActive = false;
      session.runtimeState = {
        ...this.updateRuntimeStage(runtimeState, nextStage, notification.timestamp || Date.now()),
        callActive: false,
        activeToolNames: [],
        activeToolCount: 0,
        streamToolNames: undefined,
        retryAttempt: undefined,
        maxRetries: undefined,
        nextRetryDelayMs: undefined,
        lastErrorType: outcome.error?.category ?? null,
        lastErrorMessage: outcome.error?.message ?? null,
        lastOutcome: notification.data as AgentRuntimeStateSnapshot['lastOutcome'],
      };
    } else if (notification.type === 'llm.retry') {
      // 适配器内部重试观测：waiting → retry_waiting（含退避参数），
      // requesting → retry_requesting。字段与 retryAttempt/maxRetries/
      // nextRetryDelayMs 快照字段一一对应。
      const data = (notification.data && typeof notification.data === 'object')
        ? notification.data as Record<string, unknown>
        : {};
      const phase = data.phase === 'requesting' ? 'retry_requesting' : 'retry_waiting';
      const attempt = typeof data.attempt === 'number' ? data.attempt : undefined;
      const maxRetries = typeof data.maxRetries === 'number' ? data.maxRetries : undefined;
      const delayMs = typeof data.delayMs === 'number' ? data.delayMs : undefined;
      session.runtimeState = {
        ...this.updateRuntimeStage(runtimeState, phase, notification.timestamp || Date.now()),
        callActive: session.callActive === true,
        ...(attempt !== undefined ? { retryAttempt: attempt } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
        ...(delayMs !== undefined ? { nextRetryDelayMs: delayMs } : {}),
        ...(typeof data.errorType === 'string'
          ? { lastErrorType: data.errorType, lastErrorMessage: null }
          : {}),
      };
    } else if (notification.type === 'llm.char_count') {
      const data = (notification.data && typeof notification.data === 'object')
        ? notification.data as Record<string, unknown>
        : {};
      const charCount = typeof data.charCount === 'number' ? data.charCount : runtimeState.charCount;
      const phase = typeof data.phase === 'string' ? data.phase : '';
      const toolCallCount = typeof data.toolCallCount === 'number' ? data.toolCallCount : runtimeState.toolCallCount;
      const streamToolNames = Array.isArray(data.streamToolNames)
        ? data.streamToolNames.map((n) => String(n || '')).filter(Boolean)
        : undefined;
      const nextStage = this.getRuntimeStageFromLLMPhase(phase);
      session.runtimeState = {
        ...this.updateRuntimeStage(runtimeState, nextStage, notification.timestamp || Date.now()),
        callActive: session.callActive === true,
        charCount,
        thinkingChars: typeof data.thinkingChars === 'number'
          ? data.thinkingChars
          : (phase === 'thinking' ? charCount : runtimeState.thinkingChars),
        contentChars: typeof data.contentChars === 'number'
          ? data.contentChars
          : (phase === 'content' ? charCount : runtimeState.contentChars),
        toolCallCount,
        ...(streamToolNames ? { streamToolNames } : { streamToolNames: undefined }),
      };
    } else if (notification.type === 'llm.complete') {
      const nextStage = session.callActive === true
        ? (runtimeState.activeToolCount > 0 ? 'tool_executing' : 'awaiting_runtime')
        : 'completed';
      session.runtimeState = {
        ...this.updateRuntimeStage(runtimeState, nextStage, notification.timestamp || Date.now()),
        callActive: session.callActive === true,
        streamToolNames: undefined,
      };
    } else if (notification.type === 'tool.start') {
      const data = (notification.data && typeof notification.data === 'object')
        ? notification.data as Record<string, unknown>
        : {};
      const toolName = typeof data.toolName === 'string' ? data.toolName.trim() : '';
      const activeToolNames = this.cloneRuntimeState(runtimeState).activeToolNames;
      if (toolName && !activeToolNames.includes(toolName)) {
        activeToolNames.push(toolName);
      }
      session.runtimeState = {
        ...this.updateRuntimeStage(runtimeState, 'tool_executing', notification.timestamp || Date.now()),
        callActive: session.callActive === true,
        activeToolNames,
        activeToolCount: activeToolNames.length,
      };
    } else if (notification.type === 'tool.complete') {
      const data = (notification.data && typeof notification.data === 'object')
        ? notification.data as Record<string, unknown>
        : {};
      const toolName = typeof data.toolName === 'string' ? data.toolName.trim() : '';
      const activeToolNames = this.cloneRuntimeState(runtimeState).activeToolNames
        .filter((name) => name !== toolName);
      const nextStage = session.callActive === true
        ? (activeToolNames.length > 0 ? 'tool_executing' : 'awaiting_runtime')
        : 'completed';
      session.runtimeState = {
        ...this.updateRuntimeStage(runtimeState, nextStage, notification.timestamp || Date.now()),
        callActive: session.callActive === true,
        activeToolNames,
        activeToolCount: activeToolNames.length,
      };
    }

    if (notification.category === 'state') {
      // 状态类通知：覆盖当前状态
      session.currentState = notification;
    } else if (notification.category === 'event') {
      // 事件类通知：追加到事件列表
      session.events.push(notification);
      session.lastEventCount++;
    }

    this.emitSessionEvent({ kind: 'notification', agentId });
  }

  private normalizeLogEntry(raw: any, session: AgentSession): DebugLogEntry {
    return {
      id: typeof raw?.id === 'string' ? raw.id : `log-${session.id}-${Date.now()}`,
      timestamp: typeof raw?.timestamp === 'number' ? raw.timestamp : Date.now(),
      level: raw?.level || 'info',
      message: typeof raw?.message === 'string' ? raw.message : String(raw?.message ?? ''),
      namespace: typeof raw?.namespace === 'string' ? raw.namespace : 'agent',
      context: {
        ...(raw?.context && typeof raw.context === 'object' ? raw.context : {}),
        agentId: raw?.context?.agentId || session.id,
        agentName: raw?.context?.agentName || session.name,
      },
      data: raw?.data,
      delivery: raw?.delivery && typeof raw.delivery === 'object'
        ? {
            hub: !!raw.delivery.hub,
            console: !!raw.delivery.console,
            reason: raw.delivery.reason || 'hub',
          }
        : {
            hub: true,
            console: false,
            reason: 'hub',
          },
    };
  }

  private withSessionLogContext(entry: DebugLogEntry, session: AgentSession): DebugLogEntry {
    return {
      ...entry,
      context: {
        ...entry.context,
        agentId: entry.context.agentId || session.id,
        agentName: entry.context.agentName || session.name,
      },
    };
  }

  private parseNumberParam(value: string | null): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private listAgentSummaries() {
    return Array.from(this.agentSessions.values())
      .map(session => createDebuggerAgentSummary(session, this.isSessionConnected(session)))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private getAgentDetails(agentId: string) {
    const session = this.agentSessions.get(agentId);
    if (!session) return undefined;
    return createDebuggerAgentDetails(session, this.isSessionConnected(session));
  }

  private queryLogs(query: DebuggerLogQuery) {
    const scope: 'current' | 'all' = query.scope === 'all' ? 'all' : 'current';
    const selectedAgentId = query.agentId || null;
    const requestedOffset = typeof query.offset === 'number' ? query.offset : 0;
    const hasExplicitLimit = typeof query.limit === 'number';
    const isUnboundedQuery = !hasExplicitLimit
      && requestedOffset === 0
      && !query.agentId
      && !query.level
      && !query.namespace
      && !query.feature
      && !query.lifecycle
      && typeof query.from !== 'number'
      && typeof query.to !== 'number'
      && !query.search;

    let logs: DebugLogEntry[] = [];
    if (scope === 'all') {
      for (const session of this.agentSessions.values()) {
        for (const entry of session.logs) {
          logs.push(this.withSessionLogContext(entry, session));
        }
      }
    } else {
      const session = selectedAgentId ? this.agentSessions.get(selectedAgentId) : undefined;
      logs = session ? session.logs.map((entry) => this.withSessionLogContext(entry, session)) : [];
    }

    logs.sort((a, b) => a.timestamp - b.timestamp);
    const filtered = filterDebuggerLogs(logs, {
      agentId: query.agentId,
      level: query.level,
      namespace: query.namespace,
      feature: query.feature,
      lifecycle: query.lifecycle,
      from: query.from,
      to: query.to,
      search: query.search,
    });
    const total = filtered.length;
    const effectiveLimit = hasExplicitLimit
      ? query.limit
      : isUnboundedQuery
        ? QUERY_LOGS_DEFAULT_UNBOUNDED_LIMIT
        : undefined;
    const paged = filterDebuggerLogs(logs, {
      agentId: query.agentId,
      level: query.level,
      namespace: query.namespace,
      feature: query.feature,
      lifecycle: query.lifecycle,
      from: query.from,
      to: query.to,
      limit: effectiveLimit,
      offset: query.offset,
      search: query.search,
    });
    const visibleAfterOffset = Math.max(0, total - requestedOffset);
    const truncated = typeof effectiveLimit === 'number' && paged.length < visibleAfterOffset;

    return {
      scope,
      selectedAgentId,
      total,
      logs: paged,
      truncation: truncated
        ? {
            truncated: true,
            appliedLimit: effectiveLimit,
            returnedCount: paged.length,
            availableCount: visibleAfterOffset,
            nextOffset: requestedOffset + paged.length,
            reason: isUnboundedQuery
              ? 'query_logs was called without narrowing parameters, so the server applied a safety cap.'
              : 'The requested result window was smaller than the available matching logs.',
            guidance: `Add narrowing parameters such as level, namespace, feature, lifecycle, from/to, search, or pass limit/offset explicitly. For example: {"limit": ${QUERY_LOGS_DEFAULT_UNBOUNDED_LIMIT}, "offset": ${requestedOffset + paged.length}}`,
          }
        : {
            truncated: false,
            returnedCount: paged.length,
            availableCount: visibleAfterOffset,
          },
      collectionPolicy: {
        hubConnected: this.udsClients.size > 0,
        includesOnlyHubDeliveredLogs: true,
        fallbackBehavior: 'Logs emitted without an active debugger connection fall back to local console output and do not appear here.',
      },
    };
  }

  private async handleMCP(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id, x-agentdev-agent-id');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      }));
      return;
    }

    try {
      await this.debuggerMcp.handleRequest(req, res);
    } catch (error) {
      console.error('[Viewer Worker] MCP request failed:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        }));
      }
    }
  }

  /**
   * 处理用户输入请求
   */
  public handleRequestInput(msg: any): void {
    const { agentId, requestId, prompt } = msg;
    console.log(`[Viewer Worker] 收到输入请求: agentId=${agentId}, requestId=${requestId}`);

    const session = this.agentSessions.get(agentId);
    if (!session) {
      console.warn(`[Viewer Worker] Unknown agent for input request: ${agentId}`);
      return;
    }

    this.updateSessionActivity(agentId);

    // 活跃 call 最后一次 drain 与 call.finish 之间仍可能有新输入入队。
    // 下一次兼容的文本请求出现时在框架层接力，封闭这个生命周期竞态。
    // 队首是 reminder（机器通报）时不转交：它不冒充用户应答租约，
    // 留在邮箱由空闲邮箱消费循环按 FIFO 顺序处理（跳过它转交后面的
    // 项会颠倒用户消息顺序）。
    // 队首带 commandIdentity（WorkThread 用户命令）时同样不转交：
    // 直答活动租约会绕过 claim/ack 协议（无持久 lease、无 runtime/head
    // 身份校验、无 inputReceipt 盖戳，ADR-0047 阶段 3b 明确禁止）；
    // 该命令留在持久队列，由 runtime 的 claim 路径接管。
    if (!session.inputLease && msg.mode !== 'choices' && session.queuedInputs.length > 0
      && session.queuedInputs[0].kind !== 'reminder'
      && !session.queuedInputs[0].commandIdentity) {
      const queuedInput = session.queuedInputs[0];
      const response = this.createTextInputResponse(queuedInput);
      // 移除预写（不记消费引用）：写盘失败 → 不转交，输入保留，
      // fall through 存储 lease，下个输入请求再试。
      if (this.persistRemoveQueuedInput(agentId, session.queuedInputs.slice(1))) {
        if (this.forwardInputResponse(agentId, session, requestId, queuedInput.text, response)) {
          session.queuedInputs.shift();
          console.log(`[Viewer Worker] 排队用户回合已转交给新输入请求: ${requestId}, remaining=${session.queuedInputs.length}`);
          // 转交路径不经过 dequeue 端点：队列变化必须在此 emit，否则前端
          // 排队气泡滞留（SSE 事件源完整性约束，非 IPC 写入路径）。
          this.emitSessionEvent({ kind: 'queued-inputs', agentId });
          // 转交成功才补记消费引用：补记失败 → 后续重投重新入队
          // （可见的重复，turn 事件留痕），不产生静默丢失。
          this.recordConsumedRef(agentId, queuedInput.sourceRef);
          return;
        }
        // 转交失败补救：内存首项未动，用内存全量覆盖磁盘恢复未消费态。
        // 补救写也失败 → 磁盘 items 已无该项但引用未记 → 重投可重新
        // 入队——不存在「丢且不可重发」窗口（二轮审查裁定）。
        this.saveQueuedInputState(agentId, [...session.queuedInputs], this.loadQueuedInputState(agentId).consumedSourceRefs);
      }
    }

    // 输入请求是覆盖式的唯一 lease；同一 Agent 永远不会在 Worker 中累积
    // 多张可提交卡片。DebugHub 端也持有同样的不变量以防并发来源。
    const lease: InputLease = {
      requestId,
      prompt,
      placeholder: msg.placeholder,
      initialValue: (msg as any).initialValue,
      actions: msg.actions,
      mode: msg.mode,
      questions: msg.questions,
      timestamp: Date.now(),
    };
    session.inputLease = lease;

    console.log(`[Viewer Worker] Input lease 已存储: ${requestId}`);
    this.emitSessionEvent({ kind: 'input-requests', agentId });
  }

  /**
   * 处理输入请求取消（运行时中断/销毁时由 DebugHub 发出）
   * 只有 requestId 匹配当前租约时才清除，避免误删紧随其后重开的新租约。
   */
  public handleInputRequestCancelled(msg: InputRequestCancelledMsg): void {
    const session = this.agentSessions.get(msg.agentId);
    if (!session?.inputLease || session.inputLease.requestId !== msg.requestId) {
      return;
    }
    delete session.inputLease;
    console.log(`[Viewer Worker] 输入租约已取消: agentId=${msg.agentId}, requestId=${msg.requestId}`);
    this.emitSessionEvent({ kind: 'input-requests', agentId: msg.agentId });
  }

  /**
   * /res/{agentId}/{rootId}/{rel...} — 资源读取协议资产服务（ADR-0038）。
   * 内容回源自 runtime（本地 / 容器 / 外部同链路）：经 host-request 通道
   * 发 resource.fetch，runtime 在其声明的资源根内解析读取并返回 base64。
   * 失败映射：forbidden → 403；其余（未知根 / 文件缺失 / 断连 / 超时 /
   * runtime 错误 / 协议形状不符）一律 404，前端回退默认渲染为既有降级。
   */
  public handleResAsset(req: IncomingMessage, res: ServerResponse, url: string): void {
    try {
      const match = url.match(/^\/res\/([^/]+)\/(\d+)\/(.+)$/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid resource path');
        return;
      }
      const [, rawAgentId, rootIdRaw, rawRel] = match;
      let agentId = rawAgentId;
      let rel = rawRel;
      try {
        agentId = decodeURIComponent(rawAgentId);
        rel = decodeURIComponent(rawRel);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid resource encoding');
        return;
      }
      if (rel.includes(String.fromCharCode(0)) || rel.includes(String.fromCharCode(92))) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid resource path');
        return;
      }
      const rootId = Number(rootIdRaw);

      const session = this.agentSessions.get(agentId);
      if (!session) {
        console.warn(`[Viewer Worker] /res/ 未注册 agent: ${agentId} (url=${url})`);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unknown resource agent');
        return;
      }
      const payload = this.templatePayloads.get(agentId);
      if (!payload || rootId >= payload.rootCount) {
        console.warn(`[Viewer Worker] /res/ 未注册 rootId: ${rootId} (agent=${agentId}, url=${url})`);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unknown resource root');
        return;
      }
      const targetClientId = session.clientId;
      const targetSocket = targetClientId ? this.udsClients.get(targetClientId) : null;
      if (!targetClientId || !targetSocket) {
        console.warn(`[Viewer Worker] /res/ runtime 未连接: agentId=${agentId} (url=${url})`);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Resource runtime is not connected');
        return;
      }

      void this.sendHostRequestToAgent(agentId, targetClientId, targetSocket, {
        requestType: 'resource.fetch',
        rootId,
        rel,
      }).then((response) => {
        if (response === null) {
          console.warn(`[Viewer Worker] /res/ 回源超时 (url=${url})`);
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Resource fetch timed out');
          return;
        }
        if (response.error !== undefined) {
          console.warn(`[Viewer Worker] /res/ 回源失败: ${response.error} (url=${url})`);
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Resource fetch failed');
          return;
        }
        const result = response.result as { ok?: unknown; data?: unknown; code?: unknown } | null;
        if (!result || result.ok !== true || typeof result.data !== 'string') {
          if (result && (result as any).code === 'forbidden') {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden path');
            return;
          }
          console.warn(`[Viewer Worker] /res/ 资源不可得: ${(result as any)?.code ?? 'invalid_response'} (url=${url})`);
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Resource not found');
          return;
        }

        const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
        const contentType = ext === '.js' || ext === '.mjs'
          ? 'application/javascript; charset=utf-8'
          : ext === '.json' || ext === '.map'
            ? 'application/json; charset=utf-8'
            : ext === '.css'
              ? 'text/css; charset=utf-8'
              : ext === '.md'
                ? 'text/markdown; charset=utf-8'
                : ext === '.svg'
                  ? 'image/svg+xml'
                  : ext === '.png' || ext === '.webp' || ext === '.gif' || ext === '.jpeg' || ext === '.jpg'
                    ? `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`
                    : 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          // 与旧 /tpl/ 语义一致：开发态 dist 重建后浏览器可协商更新，保留 304 能力
          'Cache-Control': 'no-cache',
        });
        res.end(Buffer.from(result.data, 'base64'));
      });
    } catch (err: any) {
      console.error('[Viewer Worker] /res/ 处理错误:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  // ========== HTML 生成（复用原有代码）==========

  private getHtml(): string {
    return generateViewerHtml(this.port);
  }
}

// 导出 ViewerWorker 类供外部使用
export { ViewerWorker };

// ========== Worker 进程入口（仅当直接运行时执行）==========

// 检查是否为主模块（不是被其他模块导入）
    const isMainModule = (url: string): boolean => {
  const mainArg = process.argv[1];
  if (!mainArg) return false;
  const mainPath = mainArg.replace(/\\/g, '/');
  const modulePath = url.startsWith('file://') ? url.substring(7) : url;
  return modulePath.endsWith(mainPath) || mainPath.endsWith(modulePath);
};

if (isMainModule(import.meta.url)) {
  // 全局错误处理
  process.on('uncaughtException', (err) => {
    console.error('[Viewer Worker] 未捕获的异常:', err);
    console.error(err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Viewer Worker] 未处理的 Promise 拒绝:', reason);
  });

  const port = parseInt(process.argv[2] || process.env.AGENTDEV_PORT || '2026', 10);
  const openBrowser = process.argv[3] !== 'false' && process.env.AGENTDEV_OPEN_BROWSER !== 'false';
  const udsPath = process.env.AGENTDEV_UDS_PATH || process.argv[4];
  const worker = new ViewerWorker(port, openBrowser, udsPath);

  worker.start().catch(err => {
    console.error('[Viewer Worker] 启动失败:', err);
    process.exit(1);
  });

  // 监听主进程消息
  process.on('message', (msg: DebugHubIPCMessage) => {
    switch (msg.type) {
      case 'register-agent':
        worker.handleRegisterAgent(msg);
        break;
      case 'update-agent-inspector':
        worker.handleUpdateAgentInspector(msg);
        break;
      case 'update-agent-overview':
        worker.handleUpdateAgentOverview(msg);
        break;
      case 'push-messages':
        worker.handlePushMessages(msg);
        break;
      case 'register-tools':
        worker.handleRegisterTools(msg);
        break;
      case 'unregister-agent':
        worker.handleUnregisterAgent(msg);
        break;
      case 'push-notification':
        worker.handlePushNotification(msg);
        break;
      case 'request-input':
        worker.handleRequestInput(msg);
        break;
      case 'input-request-cancelled':
        worker.handleInputRequestCancelled(msg);
        break;
      case 'stop':
        worker.handleStop();
        break;
    }
  });

  // 优雅退出
  process.on('SIGINT', () => {
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    process.exit(0);
  });
}
