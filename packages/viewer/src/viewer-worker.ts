
/**
 * Viewer Worker - 在独立进程中运行 HTTP 服务器
 * 支持多 Agent 调试，共享单端口
 * 支持通过 UDS（Unix Domain Socket）或 Windows Named Pipe 接收来自多进程的连接
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createServer as createNetServer, type Server, type Socket } from 'net';
import { unlinkSync, existsSync, readFile } from 'fs';
import { createHash } from 'crypto';
import { join, resolve, sep, extname } from 'path';
import { type DebugLogEntry, type AgentOverviewSnapshot, type AgentRuntimeStateSnapshot, type TodoPlanSnapshot, type TodoTaskSnapshot, type AgentSession, type DebugHubIPCMessage, type ImageInput, type InputLease, type InputRequestCancelledMsg, type QueuedInput, type UserInputResponse, type UserTurnInput, type UserTurnSubmissionResult, getDefaultUDSPath } from '@agentdevjs/core';
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
interface MessagesProbe {
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

// ============= Worker 类 =============

class ViewerWorker {
  private port: number;
  private openBrowser: boolean;
  private server: ReturnType<typeof createServer>;
  private udsPath: string;
  private udsServer?: Server;
  private udsClients: Map<string, Socket> = new Map();

  // 多 Agent 会话存储
  private agentSessions: Map<string, AgentSession> = new Map();

  // 模板装载注册表（mountId → 装载点）。mountId 是 root 的稳定哈希，
  // 多 agent 共享同一 root（如同一个框架包 junction）时复用同一条目。
  private templateMounts: Map<string, { root: string; agents: Set<string> }> = new Map();

  // 每个 agent 的模板装载载荷（agentId → { mounts 根数组, entries 模板名→{mount,rel} }）
  private templatePayloads: Map<string, { mounts: string[]; entries: Record<string, { mount: number; rel: string }> }> = new Map();

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

  constructor(port: number, openBrowser: boolean = true, udsPath?: string) {
    this.port = port;
    this.openBrowser = openBrowser;
    this.udsPath = udsPath || getDefaultUDSPath();
    this.server = createServer();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 先启动 UDS 服务器
      this.startUDSServer();

      // 再启动 HTTP 服务器
      this.server.on('request', (req, res) => this.handleRequest(req, res));

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 被占用`));
        } else {
          reject(err);
        }
      });

      // ViewerWorker is an internal debug/control transport for Claw. Keep its
      // HTTP surface on loopback; the product server is the public gateway.
      this.server.listen(this.port, '127.0.0.1', async () => {
        const url = `http://127.0.0.1:${this.port}`;
        console.log(`[Viewer Worker] ${url} (loopback only)`);
        console.log(`[Viewer Worker] MCP endpoint: ${url}/mcp`);

        // 打开浏览器（仅在 openBrowser 为 true 时）
        if (this.openBrowser) {
          try {
            const open = await import('open');
            await open.default(url).catch(() => {
              console.warn('[Viewer Worker] 浏览器打开失败，请手动访问: ' + url);
            });
          } catch {
            console.warn('[Viewer Worker] open 模块不可用，请手动访问: ' + url);
          }
        }

        // 通知主进程服务器已启动
        if (process.send) {
          process.send({ type: 'ready' });
        }

        resolve();
      });
    });
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // 关闭 HTTP 服务器
      if (this.server) {
        this.server.close(() => {
          console.log('[Viewer Worker] HTTP 服务器已关闭');
        });
      }

      // 关闭 UDS 服务器
      if (this.udsServer) {
        this.udsServer.close(() => {
          console.log('[Viewer Worker] UDS 服务器已关闭');
        });
      }

      // 关闭所有 UDS 客户端连接
      for (const [id, socket] of this.udsClients) {
        socket.destroy();
        console.log(`[Viewer Worker] 客户端连接已关闭: ${id}`);
      }
      this.udsClients.clear();

      // 清理 Unix socket 文件（非 Windows）
      if (process.platform !== 'win32' && this.udsPath && existsSync(this.udsPath)) {
        try {
          unlinkSync(this.udsPath);
        } catch {}
      }

      resolve();
    });
  }

  // ========== UDS 服务器 ==========

  /**
   * 启动 UDS 服务器
   */
  private startUDSServer(): void {
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
      });

      socket.on('error', (err) => {
        console.error('[Viewer Worker] UDS 客户端错误:', err);
        this.udsClients.delete(clientId);
      });
    });

    // 添加错误处理
    this.udsServer.on('error', (err: Error) => {
      console.error(`[Viewer Worker] UDS 服务器错误: ${err.message}`);
    });

    this.udsServer.listen(this.udsPath, () => {
      console.log(`[Viewer Worker] UDS 服务器已启动: ${this.udsPath}`);
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
    }
  }

  // ========== HTTP 请求处理 ==========

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
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

    // 模板装载资产：/tpl/{mountId}/{mount内相对路径}
    // URL 层级与 mount root 下磁盘层级同构，模板内的相对依赖（tsup 共享
    // chunk、sourcemap）按相同布局自然命中，无需任何布局推断。
    if (url.startsWith('/tpl/')) {
      this.handleTplAsset(req, res, url);
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

    // POST /api/agents/:id/dequeue-input - 消费第一条排队消息
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

    // URL = /tpl/{mountId}/{rel}。mountId 由装载根目录哈希而来，与 agent 无关：
    // 多 agent 共享同一包时浏览器复用同一份模块缓存，chunk 相对 import 也天然命中。
    const featureTemplateMapForFrontend: Record<string, string> = {};
    for (const [templateName, entry] of Object.entries(payload.entries)) {
      const root = payload.mounts[entry.mount];
      if (root === undefined) continue;
      featureTemplateMapForFrontend[templateName] = `/tpl/${ViewerWorker.mountIdForRoot(root)}/${entry.rel}`;
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
   */
  private handleGetAgentMessages(req: IncomingMessage, res: ServerResponse, agentId: string, searchParams?: URLSearchParams): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

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
      }));
      return;
    }

    if (searchParams?.get('tail') === '1') {
      const last = session.messages.length > 0 ? session.messages[session.messages.length - 1] : null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        messages: last ? [last] : [],
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      agentId,
      messages: session.messages,
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
    const overview = this.getMergedOverview(session);
    const probe = this.getMessagesProbe(session);
    res.end(JSON.stringify(probe ? { ...overview, _messagesProbe: probe } : overview));
  }

  private handleGetAgentTodoPlan(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(session.todoPlan ?? this.createEmptyTodoPlan()));
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

    const hasNewEvents = session.events.length > session.lastEventCount;
    session.lastEventCount = session.events.length;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      state: session.currentState,
      event: session.events.length > 0 ? session.events[session.events.length - 1] : null,
      runtime: this.cloneRuntimeState(this.getSessionRuntimeState(session)),
      callActive: session.callActive === true,
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

    const connected = this.isSessionConnected(session);

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

    const lease = session.inputLease;
    const requests = lease ? [{ ...lease }] : [];

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
    if (!input || typeof input.text !== 'string' || input.text.length === 0) {
      return { success: false, code: 'invalid_input', error: 'text must be a non-empty string' };
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
    if (input.capabilityActivations !== undefined
      && (!Array.isArray(input.capabilityActivations)
        || input.capabilityActivations.length > 16
        || input.capabilityActivations.some((a) => typeof a !== 'string' || a.length === 0 || a.length > 128))) {
      return { success: false, code: 'invalid_input', error: 'capabilityActivations must be an array of up to 16 non-empty strings (max 128 chars each)' };
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

    const lease = session.inputLease;
    if (lease?.mode === 'choices') {
      return {
        success: false,
        code: 'input_mode_conflict',
        error: 'A non-text interactive input request must be completed before submitting a new user turn',
        pendingMode: 'choices',
      };
    }

    if (lease) {
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
    const queuedInput = this.enqueueQueuedInput(session, input.text, input.images, input.source, input.sourceRef, input.capabilityActivations);
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
    return {
      kind: 'text',
      text: input.text,
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    };
  }

  private enqueueQueuedInput(
    session: AgentSession,
    text: string,
    images?: ImageInput[],
    source?: string,
    sourceRef?: string,
    capabilityActivations?: string[],
  ): QueuedInput {
    if (!session.queuedInputs) {
      (session as any).queuedInputs = [];
    }
    const queuedInput: QueuedInput = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text,
      timestamp: Date.now(),
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
      ...(source ? { source } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(Array.isArray(capabilityActivations) && capabilityActivations.length > 0 ? { capabilityActivations } : {}),
    };
    session.queuedInputs.push(queuedInput);
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

    const queued = session.queuedInputs || [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(queued));
  }

  /**
   * 消费第一条排队消息
   */
  private handleDequeueInput(req: IncomingMessage, res: ServerResponse, agentId: string): void {
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

    const input = queued.shift()!;
    console.log(`[Viewer Worker] 消费排队输入: ${agentId}, remaining=${queued.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ input, remaining: queued.length }));
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
        queuedInputs: [],
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
    const { agentId, name, projectRoot, templateMounts, templateEntries, hookInspector, overview, activeInputRequest, inputPolicy } = msg;
    const session = this.getOrCreateSession(agentId, name);

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

    // 收集模板装载载荷（mount 协议：mounts 为真实目录根数组，entries 为
    // 模板名 → {mount 下标, rel 相对路径}）。协议不混版：worker 只认
    // mount 载荷，旧版字段（URL 映射）一律无视。
    if (Array.isArray(templateMounts) && templateEntries && typeof templateEntries === 'object') {
      const mounts: string[] = [];
      const entries: Record<string, { mount: number; rel: string }> = {};
      const missing: string[] = [];

      for (const root of templateMounts) {
        if (typeof root !== 'string' || !root) continue;
        if (!mounts.includes(root)) mounts.push(root);
      }
      for (const [templateName, entry] of Object.entries(templateEntries)) {
        const root = mounts[(entry as any)?.mount];
        const rel = (entry as any)?.rel;
        if (typeof root !== 'string' || typeof rel !== 'string') continue;
        // 注册时验证：装载条目在磁盘必须存在。缺失在这里显性化（warn），
        // 而不是留到浏览器 404 后静默降级。
        if (!existsSync(join(root, rel))) {
          missing.push(`${templateName} -> ${join(root, rel)}`);
          continue;
        }
        entries[templateName] = { mount: mounts.indexOf(root), rel };
      }
      if (missing.length > 0) {
        console.warn(`[Viewer Worker] Agent ${agentId} 注册时发现 ${missing.length} 个模板装载条目缺失: ${missing.join('; ')}`);
      }

      this.templatePayloads.set(agentId, { mounts, entries });
      for (const root of mounts) {
        const mountId = ViewerWorker.mountIdForRoot(root);
        let mount = this.templateMounts.get(mountId);
        if (!mount) {
          mount = { root, agents: new Set() };
          this.templateMounts.set(mountId, mount);
        } else if (mount.root !== root) {
          // 哈希碰撞（概率可忽略）：拒绝注册该 root 并告警，不静默错配
          console.warn(`[Viewer Worker] mountId 碰撞: ${mountId} 已绑定 ${mount.root}，拒绝 ${root}`);
          continue;
        }
        mount.agents.add(agentId);
      }
    }

    if (hookInspector) {
      session.hookInspector = hookInspector;
    }
    if (overview) {
      session.overview = overview;
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
  }

  public handleUpdateTodoPlan(msg: { agentId: string; plan: TodoPlanSnapshot }): void {
    const { agentId, plan } = msg;
    const session = this.agentSessions.get(agentId);
    if (!session) return;
    session.todoPlan = this.normalizeTodoPlan(plan);
    this.updateSessionActivity(agentId);
  }

  /**
   * 清空 Feature 模板装载（当 Agent 断开连接时调用）：
   * 移除该 agent 的载荷，并对 mount 注册表做引用计数回收。
   */
  private clearFeatureTemplates(agentId: string): void {
    this.templatePayloads.delete(agentId);
    for (const [mountId, mount] of this.templateMounts) {
      mount.agents.delete(agentId);
      if (mount.agents.size === 0) {
        this.templateMounts.delete(mountId);
      }
    }
  }

  /**
   * 处理推送消息（带去重优化）
   *
   * 只有在消息真正变化时才更新会话并触发前端更新。推送时刻新旧数组都在手上，
   * 顺带完成变更分类（ADR-0012）并增量维护总字节缓存；分类为 rewrite 时
   * 照常更新 session.messages——修正"中段变化但 count 与末条签名均不变"
   * 被静默丢弃的盲区。
   */
  public handlePushMessages(msg: any): void {
    const { agentId, messages } = msg;
    const session = this.agentSessions.get(agentId);
    if (!session) return;

    const oldMessages = session.messages;
    const change = this.classifyMessagesChange(oldMessages, messages);

    if (change) {
      session.messages = messages;
      const store = session as any;
      // seq 只在真实变更时递增（ADR-0012 v2）：它是前端对账的同步版本号。
      // no-op 推送不清槽——后到的相同内容推送覆盖先到的未消费变更记录，
      // 正是"首条 user 消息已进转录却报无变化"延迟显示的根因。
      store._messagesChangeSeq = (typeof store._messagesChangeSeq === 'number' ? store._messagesChangeSeq : 0) + 1;
      this.updateTotalBytes(session, oldMessages, messages, change.changeKind);
      // 更新最后一条消息的签名，用于下次比较
      session._lastMessageSig = this.getLastMessageSignature(messages);
      this.updateSessionActivity(agentId);
      // 修剪前先记录条数：数量修剪经 shift() 原地缩短数组，而该数组与
      // 新推送数组同引用，事后比较会失真
      const preTrimCount = messages.length;
      this.enforceMemoryLimits(session);
      // 修剪（数量/字节超限）会移除前端已持有的历史条目，增量拼接不再
      // 安全：无论原分类为何，一律按 rewrite（ADR 语义含"修剪"）下发
      const trimmed = session.messages.length < preTrimCount;
      // fakeFullBytes 取修剪后的总字节：即此刻全量响应体的假想字节数
      store._messagesChange = {
        changeKind: trimmed ? 'rewrite' : change.changeKind,
        sinceIndex: trimmed ? 0 : change.sinceIndex,
        fakeFullBytes: store._totalBytes,
      };
    } else if (typeof (session as any)._totalBytes !== 'number') {
      // 从未走过真实变更（如 runtime 恢复推送相同内容）：probe 整体保持缺省
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
      forceContinue: null,
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
    const tasks = Array.isArray(plan.tasks) ? plan.tasks.map(task => ({
      id: String(task.id ?? ''),
      subject: String(task.subject ?? ''),
      description: String(task.description ?? ''),
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
      forceContinue: plan.forceContinue && typeof plan.forceContinue === 'object' ? {
        enabled: plan.forceContinue.enabled === true,
        consecutive: typeof plan.forceContinue.consecutive === 'number' ? plan.forceContinue.consecutive : 0,
        max: typeof plan.forceContinue.max === 'number' ? plan.forceContinue.max : 3,
      } : null,
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

    // 提取关键字段生成签名
    const sig = {
      r: lastMsg.role,
      c: lastMsg.content,
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
    if (!session.inputLease && msg.mode !== 'choices' && session.queuedInputs.length > 0) {
      const queuedInput = session.queuedInputs[0];
      const response = this.createTextInputResponse(queuedInput);
      if (this.forwardInputResponse(agentId, session, requestId, queuedInput.text, response)) {
        session.queuedInputs.shift();
        console.log(`[Viewer Worker] 排队用户回合已转交给新输入请求: ${requestId}, remaining=${session.queuedInputs.length}`);
        return;
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
  }

  /**
   * mountId：装载根目录的稳定哈希（sha1 前 12 hex）。与 agent 无关，
   * 同一 root 跨 agent / 跨注册复用同一 ID，浏览器模块缓存天然共享。
   */
  private static mountIdForRoot(root: string): string {
    return createHash('sha1').update(root.split('\\').join('/').toLowerCase()).digest('hex').slice(0, 12);
  }

  /**
   * /tpl/{mountId}/{rel...} — 模板装载资产服务。
   * mount root 下的字节级镜像：模板文件、tsup 共享 chunk、sourcemap 同构命中。
   * 唯一安全边界：resolve 后必须仍在 mount root 内（路径穿越防护）。
   */
  public handleTplAsset(req: IncomingMessage, res: ServerResponse, url: string): void {
    try {
      const match = url.match(/^\/tpl\/([0-9a-f]{12})\/(.+)$/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid template mount path');
        return;
      }
      const [, mountId, rel] = match;

      const mount = this.templateMounts.get(mountId);
      if (!mount) {
        console.warn(`[Viewer Worker] /tpl/ 未注册 mountId: ${mountId} (url=${url})`);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Unknown template mount: ${mountId}`);
        return;
      }

      // 路径穿越防护：解析后的绝对路径不得逃出 mount root
      // （win32 盘符大小写不敏感，前缀比较统一小写）
      const rootAbs = resolve(mount.root);
      const target = resolve(rootAbs, rel);
      const targetLower = target.toLowerCase();
      const rootLower = rootAbs.toLowerCase();
      if (targetLower !== rootLower && !targetLower.startsWith(rootLower + sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden path');
        return;
      }

      readFile(target, (err: any, data: Buffer) => {
        if (err) {
          console.warn(`[Viewer Worker] /tpl/ 文件缺失: ${target} (url=${url})`);
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Template asset not found');
          return;
        }
        const ext = extname(target).toLowerCase();
        const contentType = ext === '.js' || ext === '.mjs'
          ? 'application/javascript; charset=utf-8'
          : ext === '.json' || ext === '.map'
            ? 'application/json; charset=utf-8'
            : ext === '.css'
              ? 'text/css; charset=utf-8'
              : 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          // 开发态（junction 指向框架仓库）dist 会在运行中重建，chunk 名随内容
          // 变化；协商缓存保证重建后浏览器拿到新文件，同时保留 304 能力。
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      });
    } catch (err: any) {
      console.error('[Viewer Worker] /tpl/ 处理错误:', err.message);
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
