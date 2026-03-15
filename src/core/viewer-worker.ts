
/**
 * Viewer Worker - 在独立进程中运行 HTTP 服务器
 * 支持多 Agent 调试，共享单端口
 * 支持通过 UDS（Unix Domain Socket）或 Windows Named Pipe 接收来自多进程的连接
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createServer as createNetServer, Server, Socket } from 'net';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { type Message, type Tool, type DebugLogEntry, type AgentOverviewSnapshot, AgentSession, DebugHubIPCMessage, ToolMetadata, getDefaultUDSPath } from './types.js';
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
  RENDER_TEMPLATES,
  SYSTEM_RENDER_MAP,
  TOOL_DISPLAY_NAMES,
  getToolRenderConfig
} from './render.js';

const QUERY_LOGS_DEFAULT_UNBOUNDED_LIMIT = 200;

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

  // 当前选中的 Agent ID
  private currentAgentId: string | null = null;

  // Feature 模板路径映射（模板名 -> 文件路径）
  private featureTemplateMap: Record<string, string> = {};

  private readonly debuggerMcp = new DebuggerMCPServer({
    listAgents: () => this.listAgentSummaries(),
    getAgent: (agentId: string) => this.getAgentDetails(agentId),
    getCurrentAgentId: () => this.currentAgentId,
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

      this.server.listen(this.port, async () => {
        const url = `http://localhost:${this.port}`;
        console.log(`[Viewer Worker] ${url}`);
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
      socket.on('data', (data: Buffer) => {
        buffer += data.toString();
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
      case 'push-messages':
        this.handlePushMessages(msg);
        break;
      case 'register-tools':
        this.handleRegisterTools(msg);
        break;
      case 'set-current-agent':
        this.handleSetCurrentAgent(msg);
        // 发送确认
        socket.write(JSON.stringify({ type: 'agent-switched', agentId: msg.agentId }) + '\n');
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

    // 静态文件：工具渲染模板
    if (url.startsWith('/tools/')) {
      this.handleStaticToolFile(req, res, url);
      return;
    }

    // Feature 工具渲染模板
    if (url.startsWith('/features/')) {
      this.handleFeatureTemplate(req, res, url);
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

    // GET /api/agents/current - 当前 Agent
    if (url === '/api/agents/current' && req.method === 'GET') {
      this.handleGetCurrentAgent(req, res);
      return;
    }

    // PUT /api/agents/current - 切换当前 Agent
    if (url === '/api/agents/current' && req.method === 'PUT') {
      this.handleSetCurrentAgentHttp(req, res);
      return;
    }

    // GET /api/templates/feature - 获取 Feature 模板映射
    if (url === '/api/templates/feature' && req.method === 'GET') {
      this.handleGetFeatureTemplates(req, res);
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
      this.handleGetAgentMessages(req, res, msgMatch[1]);
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

    // 兼容端点：/api/messages → 当前 Agent 的消息
    if (url === '/api/messages' && req.method === 'GET') {
      if (this.currentAgentId) {
        this.handleGetAgentMessages(req, res, this.currentAgentId);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify([]));
      }
      return;
    }

    // 兼容端点：/api/tools → 当前 Agent 的工具
    if (url === '/api/tools' && req.method === 'GET') {
      if (this.currentAgentId) {
        this.handleGetAgentTools(req, res, this.currentAgentId);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify([]));
      }
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
    }));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      agents,
      currentAgentId: this.currentAgentId,
    }));
  }

  /**
   * GET /api/agents/current - 获取当前 Agent
   */
  private handleGetCurrentAgent(req: IncomingMessage, res: ServerResponse): void {
    if (!this.currentAgentId) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'No current agent' }));
      return;
    }

    const session = this.agentSessions.get(this.currentAgentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
    }));
  }

  /**
   * PUT /api/agents/current - 切换当前 Agent
   */
  public handleSetCurrentAgentHttp(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const agentId = data.agentId;

        if (!this.agentSessions.has(agentId)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Agent not found' }));
          return;
        }

        this.currentAgentId = agentId;
        this.updateSessionActivity(agentId);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, agentId }));

        // 通知主进程
        if (process.send) {
          process.send({ type: 'agent-switched', agentId });
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  /**
   * GET /api/templates/feature - 获取 Feature 模板映射
   */
  public handleGetFeatureTemplates(req: IncomingMessage, res: ServerResponse): void {
    console.log('[Viewer Worker] handleGetFeatureTemplates called, featureTemplateMap keys:', Object.keys(this.featureTemplateMap));

    // 将绝对路径转换为 HTTP URL
    const featureTemplateMapForFrontend: Record<string, string> = {};
    for (const [templateName, absolutePath] of Object.entries(this.featureTemplateMap)) {
      const normalizedPath = absolutePath.replace(/\\/g, '/');

      // 匹配多种模式（支持 src 和 dist）
      let match = normalizedPath.match(/\/dist\/features\/([^/]+)\/templates\/(.+\.render\.js)$/);
      if (!match) {
        match = normalizedPath.match(/\/src\/features\/([^/]+)\/templates\/(.+\.render\.js)$/);
      }
      if (!match) {
        match = normalizedPath.match(/^dist\/features\/([^/]+)\/templates\/(.+\.render\.js)$/);
      }
      if (!match) {
        match = normalizedPath.match(/^src\/features\/([^/]+)\/templates\/(.+\.render\.js)$/);
      }

      if (match) {
        const [, featureName, templateFile] = match;
        featureTemplateMapForFrontend[templateName] = `/features/${featureName}/${templateFile}`;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(featureTemplateMapForFrontend));
  }

  /**
   * GET /api/agents/:id/messages - 获取指定 Agent 的消息
   */
  private handleGetAgentMessages(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    const session = this.agentSessions.get(agentId);
    if (!session) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Agent not found' }));
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
    res.end(JSON.stringify(session.overview || this.createEmptyOverview()));
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
      hasNewEvents,
    }));
  }

  private handleGetLogs(req: IncomingMessage, res: ServerResponse, searchParams: URLSearchParams): void {
    const result = this.queryLogs({
      scope: searchParams.get('scope') === 'all' ? 'all' : 'current',
      agentId: searchParams.get('agentId'),
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

    if (this.currentAgentId === agentId) {
      const remaining = Array.from(this.agentSessions.values());
      const nextActive = remaining.find(candidate => this.isSessionConnected(candidate)) || remaining[0];
      this.currentAgentId = nextActive?.id || null;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      agentId,
      currentAgentId: this.currentAgentId,
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

    const pendingRequests = ((session as any).pendingInputRequests as Map<string, any>) || new Map();
    const requests = Array.from(pendingRequests.entries()).map(([requestId, data]) => ({
      requestId,
      prompt: data.prompt,
      placeholder: data.placeholder,
      initialValue: data.initialValue,
      actions: data.actions,
      timestamp: data.timestamp,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(requests));
  }

  /**
   * 提交用户输入
   */
  private handlePostInput(req: IncomingMessage, res: ServerResponse, agentId: string): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { requestId, input, response } = JSON.parse(body);

        const session = this.agentSessions.get(agentId);
        const pendingRequests = (session as any).pendingInputRequests as Map<string, any> | undefined;
        if (!session || !pendingRequests?.has(requestId)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Request not found or expired' }));
          return;
        }

        const normalizedResponse = response ?? {
          kind: 'text',
          text: input,
        };

        // 移除请求
        pendingRequests.delete(requestId);

        // 通过 UDS 发送响应到正确的客户端
        const targetClientId = session.clientId;
        if (targetClientId) {
          const targetSocket = this.udsClients.get(targetClientId);
          if (targetSocket) {
            try {
              targetSocket.write(JSON.stringify({
                type: 'input-response',
                agentId,
                requestId,
                input: normalizedResponse.text ?? input ?? '',
                response: normalizedResponse,
              }) + '\n');
              console.log(`[Viewer Worker] 输入响应已发送到 ${targetClientId}: ${requestId}`);
            } catch (writeError) {
              console.error('[Viewer Worker] UDS 写入失败:', writeError);
            }
          } else {
            console.warn(`[Viewer Worker] 目标客户端连接不存在: ${targetClientId}`);
          }
        } else {
          // 向后兼容：如果没有记录 clientId，广播到所有客户端
          console.warn('[Viewer Worker] Agent 未记录 clientId，尝试广播到所有客户端');
          for (const [cid, socket] of this.udsClients) {
            try {
              socket.write(JSON.stringify({
                type: 'input-response',
                agentId,
                requestId,
                input: normalizedResponse.text ?? input ?? '',
                response: normalizedResponse,
              }) + '\n');
              console.log(`[Viewer Worker] 输入响应广播到 ${cid}`);
            } catch (writeError) {
              console.error(`[Viewer Worker] 向 ${cid} 广播失败:`, writeError);
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
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
        events: [],
        lastEventCount: 0,
        logs: [],
        overview: this.createEmptyOverview(),
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
   */
  public enforceMemoryLimits(session: AgentSession): void {
    // 消息数量限制
    while (session.messages.length > this.MAX_MESSAGES) {
      session.messages.shift();
    }

    // 字节限制
    let byteSize = 0;
    for (let i = 0; i < session.messages.length; i++) {
      byteSize += JSON.stringify(session.messages[i]).length;
      if (byteSize > this.MAX_BYTES) {
        // 删除超出部分
        session.messages = session.messages.slice(i + 1);
        break;
      }
    }
  }

  // ========== IPC 消息处理 ==========

  /**
   * 处理注册 Agent
   */
  public handleRegisterAgent(msg: any, clientId?: string): void {
    const { agentId, name, createdAt, projectRoot, featureTemplates, hookInspector, overview, activeInputRequest } = msg;
    const session = this.getOrCreateSession(agentId, name);

    // 存储项目根目录（用于模板文件加载）
    if (projectRoot) {
      session.projectRoot = projectRoot;
    }

    // 记录所属客户端连接（用于多进程输入响应路由）
    if (clientId) {
      session.clientId = clientId;
    }

    // 收集 Feature 模板路径
    if (featureTemplates && typeof featureTemplates === 'object') {
      Object.assign(this.featureTemplateMap, featureTemplates);
    }

    if (hookInspector) {
      session.hookInspector = hookInspector;
    }
    if (overview) {
      session.overview = overview;
    }

    // 恢复活跃的输入请求（用于重连后恢复输入框）
    if (activeInputRequest) {
      let pendingRequests = (session as any).pendingInputRequests as Map<string, any>;
      if (!pendingRequests) {
        pendingRequests = new Map();
        (session as any).pendingInputRequests = pendingRequests;
      }

      // 重新存储请求
      pendingRequests.set(activeInputRequest.requestId, {
        prompt: activeInputRequest.prompt,
        placeholder: activeInputRequest.placeholder,
        initialValue: activeInputRequest.initialValue,
        actions: activeInputRequest.actions,
        timestamp: activeInputRequest.timestamp,
      });

      // 如果有活跃输入请求，自动切换到该 Agent（确保前端能看到输入框）
      this.currentAgentId = agentId;

      console.log(`[Viewer Worker] 恢复活跃输入请求: ${activeInputRequest.requestId}，切换到 Agent: ${agentId}`);
    }

    // 首个 Agent 自动成为当前（如果没有活跃输入请求的情况）
    if (this.agentSessions.size === 1 && !activeInputRequest) {
      this.currentAgentId = agentId;
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
    session.overview = overview;
    this.updateSessionActivity(agentId);
  }

  /**
   * 清空 Feature 模板映射（当 Agent 断开连接时调用）
   */
  private clearFeatureTemplates(agentId: string): void {
    // 可以在这里实现基于 agentId 的清理逻辑
    // 目前简单实现：不清空，因为多个 Agent 可能共享 Feature
  }

  /**
   * 处理推送消息（带去重优化）
   *
   * 只有在消息真正变化时才更新会话并触发前端更新
   */
  public handlePushMessages(msg: any): void {
    const { agentId, messages } = msg;
    const session = this.agentSessions.get(agentId);
    if (!session) return;

    // 消息变化检测
    const messagesChanged = this.hasMessagesChanged(session, messages);

    // 只有消息真正变化时才更新
    if (messagesChanged) {
      session.messages = messages;
      // 更新最后一条消息的签名，用于下次比较
      session._lastMessageSig = this.getLastMessageSignature(messages);
      this.updateSessionActivity(agentId);
      this.enforceMemoryLimits(session);
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
    };
  }

  /**
   * 检查消息是否发生变化
   */
  private hasMessagesChanged(session: AgentSession, newMessages: any[]): boolean {
    // 快速检查：消息数量
    if (newMessages.length !== session.messages.length) {
      return true;
    }

    // 如果没有消息，直接返回 false
    if (newMessages.length === 0) {
      return false;
    }

    // 比较最后一条消息的签名（新消息总是追加到末尾）
    const newSig = this.getLastMessageSignature(newMessages);
    const oldSig = (session as any)._lastMessageSig;

    return newSig !== oldSig;
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
   * 处理切换当前 Agent（IPC 消息）
   */
  public handleSetCurrentAgent(msg: any): void {
    const { agentId } = msg;
    if (this.agentSessions.has(agentId)) {
      this.currentAgentId = agentId;
      this.updateSessionActivity(agentId);
      console.log(`[Viewer Worker] 当前 Agent 已切换: ${agentId}`);
    }
  }

  /**
   * 处理注销 Agent
   */
  public handleUnregisterAgent(msg: any): void {
    const { agentId } = msg;
    this.agentSessions.delete(agentId);
    console.log(`[Viewer Worker] Agent 已注销: ${agentId}`);

    // 如果注销的是当前 Agent，切换到另一个
    if (this.currentAgentId === agentId) {
      const remaining = Array.from(this.agentSessions.keys());
      this.currentAgentId = remaining.length > 0 ? remaining[0] : null;
    }
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
    if (!session) return;

    this.updateSessionActivity(agentId);

    if (notification?.type === 'log.entry' && notification?.data) {
      session.logs.push(this.normalizeLogEntry(notification.data, session));
      if (session.logs.length > this.MAX_LOGS) {
        session.logs.splice(0, session.logs.length - this.MAX_LOGS);
      }
      return;
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
    const selectedAgentId = query.agentId || this.currentAgentId;
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
      const effectiveAgentId = selectedAgentId || this.currentAgentId;
      const session = effectiveAgentId ? this.agentSessions.get(effectiveAgentId) : undefined;
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
      currentAgentId: this.currentAgentId,
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

    // 初始化 pendingInputRequests（如不存在）
    let pendingRequests = (session as any).pendingInputRequests as Map<string, any>;
    if (!pendingRequests) {
      pendingRequests = new Map();
      (session as any).pendingInputRequests = pendingRequests;
    }

    // 存储请求
    pendingRequests.set(requestId, {
      prompt,
      placeholder: msg.placeholder,
      initialValue: (msg as any).initialValue,
      actions: msg.actions,
      timestamp: Date.now(),
    });

    console.log(`[Viewer Worker] Input request 已存储: ${requestId}, 当前队列大小: ${pendingRequests.size}`);
  }

  /**
   * 处理静态工具渲染文件
   * 直接返回已编译的 .js 文件内容
   * 路径规则：/tools/{category}/{filename}.js → dist/tools/{category}/{filename}.render.js
   */
  public handleStaticToolFile(req: IncomingMessage, res: ServerResponse, url: string): void {
    try {
      // 解析路径: /tools/system/shell.render.js
      const relativePath = url.substring('/tools/'.length);

      // 获取当前 Agent 的项目根目录
      const currentSession = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
      const projectRoot = currentSession?.projectRoot || process.cwd();

      // 计算完整路径：{projectRoot}/dist/tools/{relativePath}
      // 注意：relativePath 已经包含了 .render.js 后缀
      const fullPath = projectRoot
        ? join(projectRoot, 'dist/tools', relativePath)
        : join('dist/tools', relativePath);

      // 读取文件并返回
      import('fs').then((fs) => {
        fs.readFile(fullPath, 'utf-8', (err: Error | null, data: string) => {
          if (err) {
            console.error(`[Viewer Worker] 读取模板失败: ${fullPath}`, err.message);
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Template not found: ${url}`);
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(data);
        });
      }).catch((err) => {
        console.error('[Viewer Worker] fs 模块加载失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal server error');
      });
    } catch (err: any) {
      console.error('[Viewer Worker] 静态文件处理错误:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  /**
   * 处理 Feature 渲染模板文件
   * 解析路径: /features/shell/trash-delete.render.js
   * 映射到: dist/features/shell/templates/trash-delete.render.js 或 src/features/shell/templates/trash-delete.render.js
   */
  public handleFeatureTemplate(req: IncomingMessage, res: ServerResponse, url: string): void {
    try {
      // 解析路径: /features/shell/trash-delete.render.js
      const match = url.match(/^\/features\/([^/]+)\/(.+\.render\.js)$/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid feature template path');
        return;
      }

      const [, featureName, templateFile] = match;

      // 获取当前 Agent 的项目根目录
      const currentSession = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
      const projectRoot = currentSession?.projectRoot || process.cwd();

      // 构建文件路径：优先尝试 dist/，回退到 src/
      const distPath = join(projectRoot, 'dist', 'features', featureName, 'templates', templateFile);
      const srcPath = join(projectRoot, 'src', 'features', featureName, 'templates', templateFile.replace('.render.js', '.render.ts'));

      // 读取文件并返回
      import('fs').then((fs) => {
        // 先尝试 dist/ 路径
        fs.readFile(distPath, 'utf-8', (err: any, data: string) => {
          if (!err) {
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(data);
            return;
          }

          // dist/ 失败，尝试 src/ 路径
          fs.readFile(srcPath, 'utf-8', (err2: any, data2: string) => {
            if (err2) {
              console.error('[Viewer Worker] 读取 Feature 模板失败 (尝试了 dist 和 src):', {
                dist: distPath,
                src: srcPath,
                distError: err.message,
                srcError: err2.message
              });
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end(`Feature template not found: ${url}`);
              return;
            }

            // src/ 路径成功，需要将 TypeScript 内容作为 JavaScript 返回
            // 注意：浏览器可能无法直接执行 TypeScript，但至少能看到内容
            res.writeHead(200, {
              'Content-Type': 'text/javascript; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(data2);
          });
        });
      }).catch((err) => {
        console.error('[Viewer Worker] fs 模块加载失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal server error');
      });
    } catch (err: any) {
      console.error('[Viewer Worker] Feature 模板处理错误:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  // ========== HTML 生成（复用原有代码）==========

  private getHtml(): string {
    const port = this.port;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Debugger</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-dark.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>

  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css">
  <script src="https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html.min.js"></script>

  <style>
    :root {
      --bg-color: #000000;
      --sidebar-bg: #0a0a0a;
      --header-bg: #0a0a0a;
      --panel-bg: #070707;
      --border-color: #222;
      --text-primary: #ededed;
      --text-secondary: #888;
      --text-muted: #444;
      --accent-color: #ededed;
      --code-accent: #58a6ff;
      --user-msg-bg: #1a1a1a;
      --assistant-msg-bg: #000000;
      --tool-msg-bg: #050505;
      --success-color: #198754;
      --error-color: #dc3545;
      --hover-bg: #1f1f1f;
      --active-bg: #2a2a2a;
      --warning-color: #ffc107;
      --bg-secondary: var(--hover-bg);
      --scrollbar-thumb: #333;
      --scrollbar-thumb-hover: #555;
      --input-card-bg: #090909;
      --input-card-border: #222;
      --shadow-color: rgba(0, 0, 0, 0.18);
      --shadow-strong: rgba(0, 0, 0, 0.8);
      --status-text-on-color: #fff;
    }

    body[data-theme="light"] {
      --bg-color: #fafafa;
      --sidebar-bg: #f4f4f4;
      --header-bg: #f4f4f4;
      --panel-bg: #f7f7f7;
      --border-color: #d8d8d8;
      --text-primary: #121212;
      --text-secondary: #666;
      --text-muted: #8a8a8a;
      --accent-color: #121212;
      --user-msg-bg: #efefef;
      --assistant-msg-bg: #fafafa;
      --tool-msg-bg: #f1f1f1;
      --hover-bg: #eaeaea;
      --active-bg: #e2e2e2;
      --bg-secondary: var(--hover-bg);
      --scrollbar-thumb: #c0c0c0;
      --scrollbar-thumb-hover: #a7a7a7;
      --input-card-bg: #ffffff;
      --input-card-border: #d8d8d8;
      --shadow-color: rgba(0, 0, 0, 0.08);
      --shadow-strong: rgba(0, 0, 0, 0.14);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-primary);
      height: 100vh;
      display: flex;
      font-size: 14px;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      width: 260px;
      background-color: var(--sidebar-bg);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      transition: width 0.3s ease, transform 0.3s ease;
      flex-shrink: 0;
      overflow: hidden;
    }
    
    .sidebar.collapsed {
      width: 0;
      border-right: none;
    }

    .sidebar-header {
      padding: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      height: 56px;
    }
    
    .sidebar-title { font-weight: 600; font-size: 16px; }

    .agent-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .agent-item {
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: background-color 0.2s;
      color: var(--text-secondary);
    }

    .agent-item.disconnected {
      opacity: 0.8;
    }
    
    .agent-item:hover {
      background-color: var(--hover-bg);
      color: var(--text-primary);
    }
    
    .agent-item.active {
      background-color: var(--active-bg);
      color: var(--text-primary);
      font-weight: 500;
    }

    .agent-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-meta { font-size: 11px; opacity: 0.6; }
    .agent-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .agent-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--success-color);
    }
    .agent-item.disconnected .agent-status-dot {
      background: var(--error-color);
    }

    .context-menu {
      position: fixed;
      min-width: 160px;
      background: var(--sidebar-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-shadow: 0 10px 30px var(--shadow-color);
      padding: 6px;
      z-index: 1000;
      display: none;
    }
    .context-menu.open {
      display: block;
    }
    .context-menu-item {
      width: 100%;
      border: none;
      background: transparent;
      color: var(--text-primary);
      text-align: left;
      padding: 9px 10px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }
    .context-menu-item:hover {
      background: var(--hover-bg);
    }
    .context-menu-item.danger {
      color: var(--error-color);
    }
    .context-menu-item:disabled {
      color: var(--text-secondary);
      cursor: not-allowed;
      opacity: 0.6;
    }

    /* Main Content */
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      background-color: var(--bg-color);
      position: relative; /* For positioning input container */
    }

    .right-workspace {
      display: flex;
      flex-shrink: 0;
      height: 100vh;
      min-width: 56px;
    }

    .feature-panel {
      width: 0;
      background: var(--panel-bg);
      border-left: 1px solid transparent;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: width 0.24s ease, border-color 0.24s ease;
      position: relative;
      flex-shrink: 0;
    }

    .feature-panel.open {
      width: var(--feature-panel-width, 320px);
      border-left-color: var(--border-color);
    }

    .feature-panel-resizer {
      position: absolute;
      top: 0;
      left: 0;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      z-index: 2;
    }

    .feature-panel-resizer::after {
      content: '';
      position: absolute;
      left: 2px;
      top: 0;
      width: 1px;
      height: 100%;
      background: rgba(255, 255, 255, 0.08);
    }

    .feature-panel-header {
      height: 56px;
      padding: 0 16px 0 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }

    .feature-panel-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }

    .feature-panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 18px 20px 24px 22px;
      position: relative;
    }

    .feature-panel-empty {
      display: flex;
      flex-direction: column;
      gap: 10px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .feature-panel-section {
      padding: 13px 15px;
      border: 1px solid var(--border-color);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
    }

    .feature-panel-section-title {
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
    }

    .hooks-panel {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .hooks-hero {
      position: relative;
      overflow: hidden;
      padding: 18px;
      border: 1px solid var(--border-color);
      border-radius: 16px;
      background:
        radial-gradient(circle at top right, rgba(255, 120, 70, 0.20), transparent 34%),
        radial-gradient(circle at bottom left, rgba(87, 180, 255, 0.16), transparent 36%),
        linear-gradient(135deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
      box-shadow: 0 20px 50px var(--shadow-color);
    }

    .hooks-hero::after {
      content: '';
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
      background-size: 22px 22px;
      pointer-events: none;
      opacity: 0.18;
    }

    .hooks-hero > * {
      position: relative;
      z-index: 1;
    }

    .hooks-kicker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #ffb88d;
      margin-bottom: 10px;
    }

    .hooks-kicker::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: linear-gradient(135deg, #ff9b62, #ffd27f);
      box-shadow: 0 0 18px rgba(255, 155, 98, 0.45);
    }

    .hooks-hero-title {
      font-size: 21px;
      line-height: 1.1;
      font-weight: 700;
      margin-bottom: 8px;
      color: var(--text-primary);
    }

    .hooks-hero-subtitle {
      color: var(--text-secondary);
      line-height: 1.65;
      max-width: 34ch;
      margin-bottom: 16px;
    }

    .hooks-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .hooks-stat {
      padding: 11px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
    }

    body[data-theme="light"] .hooks-stat {
      background: rgba(255, 255, 255, 0.8);
    }

    .hooks-stat-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }

    .hooks-stat-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .hooks-summary {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      border: 1px solid var(--border-color);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.02);
    }

    .hooks-summary-top {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }

    .hooks-summary-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .hooks-summary-meta {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .hooks-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .hooks-chip {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
    }

    .hooks-chip.active {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.06);
    }

    .hooks-chip strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    .hooks-section {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .overview-doc {
      padding: 17px 19px;
      border-radius: 14px;
    }

    .overview-doc .markdown-body {
      font-size: 12.5px !important;
      line-height: 1.8 !important;
    }

    .overview-doc .markdown-body p {
      margin-bottom: 13px !important;
    }

    .overview-doc .markdown-body pre {
      margin: 14px 0 !important;
      font-size: 12px !important;
    }

    .hooks-section-header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
    }

    .hooks-section-title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-primary);
    }

    .hooks-section-meta {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .feature-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .overview-usage-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .context-chip-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .context-chip {
      padding: 14px 15px;
      border-radius: 16px;
      border: 1px solid var(--border-color);
      background:
        linear-gradient(135deg, rgba(91, 192, 255, 0.08), rgba(255, 156, 100, 0.08)),
        rgba(255, 255, 255, 0.03);
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 96px;
    }

    body[data-theme="light"] .context-chip {
      background:
        linear-gradient(135deg, rgba(91, 192, 255, 0.12), rgba(255, 156, 100, 0.10)),
        rgba(255, 255, 255, 0.92);
    }

    .context-chip-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
    }

    .context-chip-value {
      font-size: 22px;
      line-height: 1;
      font-weight: 800;
      color: var(--text-primary);
    }

    .context-chip-meta {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .usage-card {
      padding: 14px;
      border-radius: 16px;
      border: 1px solid var(--border-color);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02)),
        rgba(255, 255, 255, 0.02);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.12);
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 184px;
    }

    body[data-theme="light"] .usage-card {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(250, 250, 250, 0.88)),
        rgba(255, 255, 255, 0.9);
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
    }

    .usage-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .usage-card-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-primary);
    }

    .usage-card-subtitle {
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    .usage-card-total {
      font-size: 24px;
      line-height: 1;
      font-weight: 800;
      color: var(--text-primary);
      white-space: nowrap;
    }

    .usage-bar {
      display: flex;
      width: 100%;
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .usage-bar-fill {
      height: 100%;
    }

    .usage-bar-fill.input {
      background: linear-gradient(90deg, #5bc0ff, #8be8ff);
    }

    .usage-bar-fill.output {
      background: linear-gradient(90deg, #ff9c64, #ffd17b);
    }

    .usage-split-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 14px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .usage-split-legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      display: inline-block;
    }

    .legend-dot.input {
      background: #73d6ff;
    }

    .legend-dot.output {
      background: #ffb576;
    }

    .usage-stat-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .usage-stat-cell {
      padding: 10px 11px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    body[data-theme="light"] .usage-stat-cell {
      background: rgba(248, 250, 252, 0.9);
      border-color: rgba(15, 23, 42, 0.06);
    }

    .usage-stat-cell-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
      margin-bottom: 5px;
    }

    .usage-stat-cell-value {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .rate-ring-card {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: center;
      gap: 16px;
      min-height: 92px;
    }

    .rate-ring {
      width: 92px;
      height: 92px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background:
        conic-gradient(#7dd3a4 calc(var(--ring-percent) * 1%), rgba(255,255,255,0.08) 0);
      position: relative;
    }

    .rate-ring::after {
      content: '';
      position: absolute;
      inset: 10px;
      border-radius: 50%;
      background: var(--panel-bg);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    body[data-theme="light"] .rate-ring::after {
      background: #ffffff;
      border-color: rgba(15, 23, 42, 0.06);
    }

    .rate-ring-inner {
      position: relative;
      z-index: 1;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .rate-ring-value {
      font-size: 18px;
      font-weight: 800;
      color: var(--text-primary);
      line-height: 1;
    }

    .rate-ring-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
    }

    .rate-ring-meta {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .hooks-collapsible {
      border: 1px solid var(--border-color);
      border-radius: 14px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.02);
    }

    .hooks-collapsible > summary {
      list-style: none;
      cursor: pointer;
    }

    .hooks-collapsible > summary::-webkit-details-marker {
      display: none;
    }

    .hooks-collapsible-body {
      padding: 0 12px 12px 12px;
      border-top: 1px solid var(--border-color);
    }

    .feature-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .feature-card {
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.02);
      cursor: pointer;
      transition: border-color 0.18s ease, transform 0.18s ease, background 0.18s ease;
    }

    .feature-card:hover {
      border-color: rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.04);
      transform: translateY(-1px);
    }

    .feature-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .feature-card-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .feature-card-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #7dd3a4;
      flex-shrink: 0;
    }

    .feature-card-name {
      font-weight: 700;
      color: var(--text-primary);
    }

    .feature-card-file {
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .feature-badge {
      padding: 3px 7px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.05);
    }

    .feature-badge.status-enabled {
      color: #14532d;
      background: rgba(134, 239, 172, 0.92);
      border-color: rgba(74, 222, 128, 0.9);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
    }

    .feature-badge.status-partial {
      color: #7c2d12;
      background: rgba(253, 186, 116, 0.92);
      border-color: rgba(251, 146, 60, 0.9);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
    }

    .feature-badge.status-disabled {
      color: #7f1d1d;
      background: rgba(252, 165, 165, 0.9);
      border-color: rgba(248, 113, 113, 0.88);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    }

    body[data-theme="light"] .feature-badge.status-enabled {
      color: #166534;
      background: rgba(220, 252, 231, 1);
    }

    body[data-theme="light"] .feature-badge.status-partial {
      color: #9a3412;
      background: rgba(255, 237, 213, 1);
    }

    body[data-theme="light"] .feature-badge.status-disabled {
      color: #991b1b;
      background: rgba(254, 226, 226, 1);
    }

    .feature-card-detail {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      color: var(--text-secondary);
      font-size: 12px;
      margin-top: 7px;
    }

    .feature-detail-shell {
      position: static;
      min-height: 100%;
    }

    .feature-detail-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(5, 7, 12, 0.86);
      backdrop-filter: blur(2px);
      z-index: 20;
    }

    body[data-theme="light"] .feature-detail-overlay {
      background: rgba(18, 20, 26, 0.72);
    }

    .feature-detail-window {
      width: min(100%, 720px);
      max-height: min(100%, 700px);
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
      border-radius: 18px;
      border: 1px solid var(--border-color);
      background: var(--panel-bg);
      box-shadow: 0 28px 70px rgba(0, 0, 0, 0.34);
      padding: 18px;
    }

    .feature-detail-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }

    .feature-detail-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 6px;
    }

    .feature-detail-subtitle {
      font-size: 12px;
      line-height: 1.7;
      color: var(--text-secondary);
    }

    .feature-detail-close {
      width: 32px;
      height: 32px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-primary);
      cursor: pointer;
      flex-shrink: 0;
    }

    .feature-detail-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .feature-detail-stat {
      padding: 10px 11px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.02);
    }

    .feature-detail-stat-label {
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: 5px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .feature-detail-stat-value {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .feature-tool-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
    }

    .feature-tool-card {
      padding: 11px 12px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.02);
    }

    .feature-tool-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
    }

    .feature-tool-name {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-primary);
    }

    .feature-tool-desc {
      font-size: 12px;
      line-height: 1.7;
      color: var(--text-secondary);
    }

    .feature-tool-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .feature-tool-pill {
      padding: 3px 7px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      font-size: 10px;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.03);
    }

    .hook-lifecycle-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .hook-lifecycle-card {
      border: 1px solid var(--border-color);
      border-radius: 14px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.02);
    }

    .hook-lifecycle-card[open] {
      background: rgba(255, 255, 255, 0.03);
    }

    .hook-lifecycle-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 13px 15px;
      cursor: pointer;
      list-style: none;
    }

    .hook-lifecycle-head::-webkit-details-marker {
      display: none;
    }

    .hook-lifecycle-name {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text-primary);
      font-weight: 700;
    }

    .hook-lifecycle-icon {
      width: 24px;
      height: 24px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 800;
      color: #111;
      background: linear-gradient(135deg, #f0d896, #e59d73);
    }

    .hook-lifecycle-type {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .hook-call-chain {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0 12px 12px 12px;
      border-top: 1px solid var(--border-color);
    }

    .hook-step {
      display: flex;
      gap: 10px;
      padding-top: 8px;
    }

    .hook-step-order {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-primary);
      flex-shrink: 0;
      margin-top: 2px;
    }

    .hook-step-card {
      flex: 1;
      padding: 10px 11px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.018);
    }

    .hook-step-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 6px;
    }

    .hook-step-feature {
      font-size: 12px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .hook-step-kind {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 3px 7px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      background: rgba(255,255,255,0.05);
    }

    .hook-step-method {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 4px;
      word-break: break-word;
    }

    .hook-step-location {
      font-size: 12px;
      color: var(--text-secondary);
      word-break: break-all;
    }

    .hook-step-notes {
      margin-top: 8px;
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .hook-lifecycle-toggle {
      color: var(--text-secondary);
      font-size: 13px;
      flex-shrink: 0;
      transition: transform 0.18s ease;
    }

    .hook-lifecycle-card[open] .hook-lifecycle-toggle {
      transform: rotate(90deg);
    }

    .log-toolbar {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--border-color);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.02);
    }

    .log-panel {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .mcp-panel {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .mcp-hero {
      position: relative;
      overflow: hidden;
      padding: 18px;
      border: 1px solid var(--border-color);
      border-radius: 16px;
      background:
        radial-gradient(circle at top right, rgba(71, 195, 160, 0.22), transparent 34%),
        radial-gradient(circle at bottom left, rgba(80, 133, 255, 0.16), transparent 36%),
        linear-gradient(135deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
      box-shadow: 0 20px 50px var(--shadow-color);
    }

    .mcp-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .mcp-stat {
      padding: 12px 13px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.03);
    }

    .mcp-stat-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }

    .mcp-stat-value {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.4;
      word-break: break-all;
    }

    .mcp-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      font-size: 12px;
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.04);
      margin-top: 12px;
    }

    .mcp-status-pill::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #4ade80;
      box-shadow: 0 0 16px rgba(74, 222, 128, 0.4);
    }

    .mcp-code {
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: rgba(0, 0, 0, 0.22);
      font-size: 12px;
      line-height: 1.65;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .mcp-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .mcp-item {
      padding: 11px 12px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.02);
    }

    .mcp-item-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
    }

    .mcp-item-name {
      font-weight: 700;
      color: var(--text-primary);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .mcp-item-type {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .mcp-item-desc {
      font-size: 12px;
      line-height: 1.7;
      color: var(--text-secondary);
    }

    .log-filter-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .log-filter-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
      min-width: 54px;
    }

    .log-chip-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .log-chip {
      appearance: none;
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-secondary);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: background-color 0.18s ease, color 0.18s ease, border-color 0.18s ease;
    }

    .log-chip:hover,
    .log-chip.active {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.18);
    }

    .log-input,
    .log-select {
      border: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-primary);
      border-radius: 10px;
      padding: 8px 10px;
      font-size: 12px;
      min-height: 34px;
      font-family: inherit;
      outline: none;
    }

    .log-input:focus,
    .log-select:focus {
      border-color: rgba(88, 166, 255, 0.45);
      box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.12);
    }

    .log-input {
      flex: 1;
      min-width: 140px;
    }

    .log-select {
      min-width: 130px;
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      padding-right: 34px;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--text-secondary) 50%),
        linear-gradient(135deg, var(--text-secondary) 50%, transparent 50%);
      background-position:
        calc(100% - 18px) calc(50% - 1px),
        calc(100% - 12px) calc(50% - 1px);
      background-size: 6px 6px, 6px 6px;
      background-repeat: no-repeat;
    }

    .log-select option {
      background: var(--panel-bg);
      color: var(--text-primary);
    }

    .log-select option:checked,
    .log-select option:hover {
      background: var(--hover-bg);
      color: var(--text-primary);
    }

    .log-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--text-secondary);
      font-size: 12px;
    }

    .log-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .log-card {
      border: 1px solid var(--border-color);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.02);
      overflow: hidden;
    }

    .log-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 11px 13px 8px 13px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }

    .log-card-main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }

    .log-level {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 3px 7px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      background: rgba(255,255,255,0.04);
    }

    .log-level.debug, .log-level.trace {
      color: #7cc5ff;
    }

    .log-level.info {
      color: #7dd3a4;
    }

    .log-level.warn {
      color: #f6c96c;
    }

    .log-level.error {
      color: #ff8f8f;
    }

    .log-namespace {
      font-size: 12px;
      color: var(--text-secondary);
      font-family: "Fira Code", "Cascadia Code", "JetBrains Mono", ui-monospace, monospace;
    }

    .log-timestamp {
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .log-card-body {
      padding: 12px 13px 13px 13px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .log-message {
      font-size: 15px;
      line-height: 1.75;
      color: var(--text-primary);
      word-break: break-word;
    }

    .log-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .log-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      font-size: 11px;
      color: var(--text-secondary);
      background: rgba(255,255,255,0.03);
    }

    .log-details {
      border-top: 1px solid rgba(255,255,255,0.05);
      padding-top: 10px;
    }

    .log-details summary {
      cursor: pointer;
      color: var(--text-secondary);
      font-size: 12px;
      list-style: none;
    }

    .log-details summary::-webkit-details-marker {
      display: none;
    }

    .log-details pre {
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--border-color);
      background: rgba(0, 0, 0, 0.22);
      color: var(--text-primary);
      overflow: auto;
      font-size: 13px;
      line-height: 1.6;
    }

    @media (max-width: 1360px) {
      .overview-usage-grid {
        grid-template-columns: 1fr;
      }

      .context-chip-grid {
        grid-template-columns: 1fr;
      }

      .feature-grid {
        grid-template-columns: 1fr;
      }

      .hooks-stats {
        grid-template-columns: 1fr;
      }
    }

    .right-rail {
      width: 56px;
      border-left: 1px solid var(--border-color);
      background: var(--sidebar-bg);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 10px 0;
      gap: 8px;
      flex-shrink: 0;
    }

    .rail-spacer {
      flex: 1;
    }

    .rail-button {
      width: 40px;
      height: 40px;
      border: 1px solid transparent;
      border-radius: 10px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.2s, color 0.2s, border-color 0.2s;
    }

    .rail-button:hover {
      background: var(--hover-bg);
      color: var(--text-primary);
    }

    .rail-button.active {
      background: var(--active-bg);
      border-color: var(--border-color);
      color: var(--text-primary);
    }

    header {
      background-color: var(--header-bg);
      border-bottom: 1px solid var(--border-color);
      padding: 0 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      height: 56px;
      flex-shrink: 0;
    }

    .header-left { display: flex; align-items: center; gap: 12px; }

    .toggle-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 6px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .toggle-btn:hover { background-color: var(--hover-bg); color: var(--text-primary); }

    h1 { font-size: 16px; font-weight: 600; color: var(--text-primary); }

    .status-badge {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--success-color);
      color: var(--status-text-on-color);
      font-weight: 500;
    }
    .status-badge.disconnected { background: var(--error-color); }

    .markdown-body code.inline-code-accent {
      color: var(--code-accent) !important;
      background: transparent !important;
      padding: 0 !important;
      border-radius: 0 !important;
      font-size: inherit !important;
      font-family: inherit !important;
      font-weight: inherit !important;
      line-height: inherit !important;
    }

    .markdown-body pre code {
      color: inherit !important;
    }

    #chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      padding-bottom: 200px; /* 增加底部空间，避免输入框遮挡最新消息 */
      display: flex;
      flex-direction: column;
      gap: 24px;
      scroll-behavior: smooth;
    }

    .follow-latest-btn {
      position: absolute;
      right: 20px;
      bottom: 132px;
      z-index: 20;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--border-color);
      background: color-mix(in srgb, var(--panel-bg) 88%, transparent);
      color: var(--text-secondary);
      border-radius: 999px;
      padding: 10px 14px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      box-shadow: 0 8px 24px var(--shadow-color);
      backdrop-filter: blur(10px);
      transition: all 0.2s ease;
    }

    .follow-latest-btn:hover {
      color: var(--text-primary);
      border-color: var(--text-secondary);
      transform: translateY(-1px);
    }

    .follow-latest-btn.active {
      color: var(--text-primary);
      border-color: color-mix(in srgb, var(--success-color) 55%, var(--border-color));
      background: color-mix(in srgb, var(--success-color) 16%, var(--panel-bg));
    }

    .follow-latest-btn.hidden {
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
    }

    .follow-latest-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--text-muted);
      transition: background 0.2s ease, box-shadow 0.2s ease;
    }

    .follow-latest-btn.active .follow-latest-dot {
      background: var(--success-color);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--success-color) 18%, transparent);
    }

    @media (max-width: 768px) {
      .follow-latest-btn {
        right: 16px;
        bottom: 116px;
        padding: 9px 12px;
      }
    }

    /* Message Styles */
    .message-row {
      display: flex;
      flex-direction: column;
      max-width: 800px;
      width: 100%;
      margin: 0 auto;
      gap: 6px;
    }

    .message-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary);
      padding: 0 4px;
    }

    .role-badge { font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }

    .message-action {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
    }

    .message-action:hover {
      color: var(--text-primary);
      border-color: var(--text-secondary);
      background: var(--hover-bg);
    }

    .message-content {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 15px;
      line-height: 1.6;
      position: relative;
      overflow-wrap: break-word;
    }

    .message-content.collapsed {
      max-height: 160px;
      mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
      overflow: hidden;
    }

    .message-row.system.long-content { align-items: stretch; }
    .message-row.system.long-content .message-content {
      text-align: left !important;
      width: 100%;
    }
    .message-content.collapsed {
      max-height: 160px;
      mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
      cursor: default;
    }
    
    .expand-toggle-bar {
      display: flex;
      justify-content: center;
      padding-top: 4px;
      margin-bottom: 8px;
      width: 100%;
    }
    
    .expand-toggle-btn {
      background: var(--tool-msg-bg);
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      border-radius: 12px;
      padding: 4px 12px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      font-family: inherit;
    }
    
    .expand-toggle-btn:hover {
      background: var(--hover-bg);
      color: var(--text-primary);
      border-color: var(--text-secondary);
    }
    
    .expand-toggle-btn svg {
      width: 12px;
      height: 12px;
      fill: currentColor;
    }

    .message-row.user .message-content {
      background-color: var(--user-msg-bg);
      color: var(--text-primary);
      align-self: flex-end;
      max-width: 85%;
      border-bottom-right-radius: 2px;
    }
    
    .message-row.user { align-items: flex-end; }
    .message-row.user .message-meta { justify-content: flex-end; }

    .message-row.assistant .message-content {
      background-color: transparent;
      padding: 0;
      width: 100%;
    }

    .message-row.system { align-items: center; gap: 4px; margin: 12px auto; opacity: 0.8; }
    .message-row.system .message-content {
      background: transparent;
      border: 1px dashed var(--border-color);
      padding: 8px 16px;
      font-size: 13px;
      color: var(--text-secondary);
      text-align: center;
    }

    /* Tool Styles */
    .tool-call-container {
      margin-top: 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      overflow: hidden;
      background: var(--tool-msg-bg);
    }
    
    .tool-header {
      background: var(--hover-bg);
      padding: 6px 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-color);
    }
    .tool-header-name { color: var(--text-primary); font-weight: 600; }
    .tool-content { padding: 12px; font-size: 13px; color: var(--text-primary); overflow-x: auto; }

    .tool-result-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--hover-bg);
      border-radius: 6px 6px 0 0;
      font-size: 12px;
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
      border-bottom: none;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.success { background-color: var(--success-color); box-shadow: 0 0 4px rgba(25, 135, 84, 0.4); }
    .status-dot.error { background-color: var(--error-color); box-shadow: 0 0 4px rgba(220, 53, 69, 0.4); }

    .tool-result-body {
      background: var(--tool-msg-bg);
      border: 1px solid var(--border-color);
      border-top: none;
      border-radius: 0 0 6px 6px;
      padding: 12px;
      overflow-x: auto;
      font-size: 13px;
    }

    /* System Tool Rendering */
    .bash-command { font-family: "Fira Code", "Cascadia Code", "Source Code Pro", "JetBrains Mono", ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace; color: var(--text-primary); }
    .bash-output { font-family: "Fira Code", "Cascadia Code", "Source Code Pro", "JetBrains Mono", ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace; color: var(--text-secondary); white-space: pre-wrap; margin: 0; }
    .file-path { color: #58a6ff; }
    
    .ls-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
      max-height: 500px;
      overflow-y: auto;
    }
    .ls-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px;
      background: var(--hover-bg);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      cursor: default;
      transition: all 0.2s;
    }
    .ls-item:hover { backgro"Fira Code", "Cascadia Code", "Source Code Pro", "JetBrains Mono", und: var(--active-bg); border-color: #444; transform: translateY(-1px); }
    .ls-icon { color: var(--text-secondary); display: flex; align-items: center; }
    .ls-name { font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
    
    .markdown-body table {
      width: 100% !important;
      border-collapse: collapse !important;
      margin-bottom: 16px !important;
      background-color: #161b22 !important;
      border-radius: 6px !important;
      overflow: hidden !important;
      display: table !important;
    }
    .markdown-body th, .markdown-body td {
      padding: 8px 12px !important;
      border: 1px solid #30363d !important;
    }
    .markdown-body th {
      background-color: #161b22 !important;
      font-weight: 600 !important;
      text-align: left !important;
      color: var(--text-primary) !important;
    }
    .markdown-body tr { background-color: #0d1117 !important; }
    .markdown-body tr:nth-child(2n) { background-color: #161b22 !important; }

    .tool-error {
      background: rgba(220, 53, 69, 0.1);
      border: 1px solid rgba(220, 53, 69, 0.3);
      color: #ff6b6b;
      padding: 10px 14px;
      border-radius: 6px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 13px;
      line-height: 1.5;
    }
    .tool-error svg { flex-shrink: 0; margin-top: 2px; }
    
    .markdown-body { color: var(--text-primary) !important; font-family: inherit !important; background: transparent !important; }
    .markdown-body pre { background-color: #111 !important; border-radius: 6px; }

    .empty-state { text-align: center; margin-top: 20vh; color: var(--text-secondary); }

    /* 通知状态指示器 */
    .notification-status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--hover-bg);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-secondary);
    }
    .notification-status.active {
      color: var(--text-primary);
      background: rgba(88, 166, 255, 0.15);
    }
    .notification-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-secondary);
      animation: pulse 1.5s ease-in-out infinite;
    }
    .notification-status.active .notification-indicator {
      background: #58a6ff;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .notification-phase {
      font-weight: 500;
    }
    .notification-char-count {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
    }
    
    /* Reasoning */
    .reasoning-block {
      margin-bottom: 16px;
      border-left: 2px solid var(--border-color);
      padding-left: 12px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 0 4px 4px 0;
    }
    .reasoning-header { 
      padding: 6px 0;
      font-size: 12px; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; gap: 6px;
      user-select: none;
    }
    .reasoning-content { display: none; padding-bottom: 8px; font-size: 13px; color: var(--text-secondary); }
    .reasoning-block.expanded .reasoning-content { display: block; animation: fadeIn 0.2s; }
    .reasoning-icon { transition: transform 0.2s; }
    .reasoning-block.expanded .reasoning-icon { transform: rotate(90deg); }
    
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

    /* ========== Read 工具：简洁代码显示（无框体） ========== */
    .code-read-container {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 20px;
    }
    .code-read-line {
      display: flex;
      white-space: pre;
    }
    .code-read-line-num {
      padding-right: 16px;
      text-align: right;
      color: #6e7681;
      user-select: none;
      min-width: 40px;
      flex-shrink: 0;
    }
    .code-read-content {
      flex: 1;
      white-space: pre;
    }

    /* ========== Diff2Html 深色模式适配 ========== */
    .d2h-wrapper {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
      font-size: 12px;
      background: transparent !important;
    }
    .d2h-file-header {
      background-color: #21262d !important;
      border-bottom: 1px solid #30363d !important;
      padding: 4px 8px !important;
    }
    .d2h-file-name {
      color: #c9d1d9 !important;
      font-size: 11px !important;
    }
    .d2h-diff-table {
      font-size: 12px;
    }
    .d2h-code-line-ctn {
      color: #c9d1d9;
    }
    .d2h-code-side {
      border: none !important;
    }
    .d2h-file-diff {
      border: none !important;
      border-radius: 0 !important;
      background: transparent !important;
    }
    .d2h-files-diff {
      border: none !important;
      border-radius: 0 !important;
      background: transparent !important;
    }

    /* 用户输入容器（默认隐藏） */
    #user-input-container {
      display: none;
      position: absolute;
      bottom: 50px;
      left: 0;
      right: 0;
      z-index: 1000;
      display: flex;
      justify-content: center;
      pointer-events: none; /* 让空白区域不阻挡点击 */
    }

    #user-input-container:not(:empty) {
      display: flex;
    }

    .user-input-card {
      pointer-events: auto;
      background: var(--input-card-bg);
      border: 1px solid var(--input-card-border);
      border-radius: 24px;
      padding: 18px 24px;
      box-shadow: 0 8px 32px var(--shadow-strong);
      width: 85%;
      max-width: 800px;
      display: flex;
      flex-direction: column;
    }

    .user-input-header {
      display: none;
    }

    .user-input-prompt {
      display: none; 
    }

    .user-input-textarea {
      width: 100%;
      background: transparent;
      color: var(--text-primary);
      border: none;
      padding: 0;
      font-family: inherit; /* 跟随 body 字体，即用户消息的字体 */
      font-size: 16px;
      line-height: 1.6;
      resize: none;
      box-sizing: border-box;
      outline: none;
      min-height: 26px;
      max-height: 300px; 
    }
    
    .user-input-textarea::placeholder {
      color: var(--text-muted);
    }

    .user-input-textarea:focus {
      border-color: transparent;
    }

    .user-input-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 12px;
      gap: 12px;
    }

    .user-input-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .user-input-action {
      border: 1px solid var(--border-color);
      background: transparent;
      color: var(--text-secondary);
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.2s ease;
    }

    .user-input-action:hover {
      color: var(--text-primary);
      border-color: var(--text-secondary);
      background: var(--hover-bg);
    }

    .user-input-action.danger {
      color: #d9534f;
      border-color: rgba(217, 83, 79, 0.35);
    }

    .user-input-action.primary {
      color: var(--text-primary);
      border-color: var(--text-primary);
    }

  </style>
</head>
<body>
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-title">Agents</div>
    </div>
    <div class="agent-list" id="agent-list">
      <!-- Agent items -->
    </div>
  </div>

  <div class="main-content">
    <header>
      <div class="header-left">
        <button class="toggle-btn" id="sidebar-toggle" title="Toggle Sidebar">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <h1 id="current-agent-name">Agent Debugger</h1>
        <div id="notification-status" class="notification-status" style="display: none;">
          <div class="notification-indicator"></div>
          <span class="notification-phase" id="notification-phase"></span>
          <span class="notification-char-count" id="notification-char-count"></span>
          <span>字符</span>
        </div>
      </div>
      <span id="connection-status" class="status-badge">Connected</span>
    </header>

    <div id="chat-container">
      <div class="empty-state">Waiting for messages...</div>
    </div>
    <button id="follow-latest-btn" class="follow-latest-btn hidden" type="button"></button>
    
    <div id="user-input-container"></div>
  </div>

  <div class="right-workspace">
    <aside id="feature-panel" class="feature-panel">
      <div id="feature-panel-resizer" class="feature-panel-resizer" title="Resize panel"></div>
      <div class="feature-panel-header">
        <div id="feature-panel-title" class="feature-panel-title">Workspace</div>
      </div>
      <div id="feature-panel-body" class="feature-panel-body">
        <div class="feature-panel-empty">
          <div>选择右侧功能按钮以展开面板。</div>
        </div>
      </div>
    </aside>

    <aside class="right-rail" id="right-rail">
      <button class="rail-button" id="rail-workspace" title="Structure" data-panel="workspace">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="4" width="18" height="16" rx="2"></rect>
          <path d="M9 4v16"></path>
        </svg>
      </button>
      <button class="rail-button" id="rail-monitor" title="Monitor" data-panel="monitor">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 19h16"></path>
          <path d="M7 16V9"></path>
          <path d="M12 16V5"></path>
          <path d="M17 16v-4"></path>
        </svg>
      </button>
      <button class="rail-button" id="rail-hooks" title="Features" data-panel="hooks">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M8 7a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z"></path>
          <path d="M22 7a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z"></path>
          <path d="M15 17a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z"></path>
          <path d="M8 7h8"></path>
          <path d="M11 10v4"></path>
        </svg>
      </button>
      <button class="rail-button" id="rail-inspector" title="Reverse Hooks" data-panel="inspector">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="11" cy="11" r="6"></circle>
          <path d="m20 20-3.5-3.5"></path>
        </svg>
      </button>
      <button class="rail-button" id="rail-logs" title="Logs" data-panel="logs">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M4 19h16"></path>
          <path d="M7 15h3"></path>
          <path d="M7 11h10"></path>
          <path d="M7 7h7"></path>
        </svg>
      </button>
      <button class="rail-button" id="rail-mcp" title="MCP" data-panel="mcp">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="5" width="18" height="14" rx="3"></rect>
          <path d="M7 12h4"></path>
          <path d="M13 12h4"></path>
          <path d="M12 9v6"></path>
        </svg>
      </button>
      <div class="rail-spacer"></div>
      <button class="rail-button" id="language-toggle" title="Switch Language" type="button">EN</button>
      <button class="rail-button" id="theme-toggle" title="切换主题" type="button">
        <svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path>
        </svg>
      </button>
    </aside>
  </div>

  <div id="agent-context-menu" class="context-menu">
    <button id="delete-agent-action" class="context-menu-item danger" type="button">删除 Agent</button>
  </div>

  <script>
    // Feature 模板映射（从 API 动态加载）
    let FEATURE_TEMPLATE_MAP = {};

    // 加载 Feature 模板映射
    async function loadFeatureTemplateMap() {
      try {
        const response = await fetch('/api/templates/feature');
        if (response.ok) {
          const data = await response.json();
          if (Object.keys(data).length > 0) {
            FEATURE_TEMPLATE_MAP = data;
            return true;
          }
        }
        return false;
      } catch (e) {
        console.warn('[Viewer] Failed to load feature templates:', e);
        return false;
      }
    }

    // 重新加载 Feature 模板映射
    async function reloadFeatureTemplateMap() {
      console.log('[Viewer] Reloading feature templates...');
      const success = await loadFeatureTemplateMap();
      if (success) {
        // 重新加载当前页面的工具配置
        if (currentAgentId) {
          await loadAgentTools(currentAgentId);
          // 重新渲染当前消息
          if (currentMessages.length > 0) {
            render(currentMessages);
          }
        }
      }
    }

    const container = document.getElementById('chat-container');
    const statusBadge = document.getElementById('connection-status');
    const agentList = document.getElementById('agent-list');
    const currentAgentTitle = document.getElementById('current-agent-name');
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const featurePanel = document.getElementById('feature-panel');
    const featurePanelTitle = document.getElementById('feature-panel-title');
    const featurePanelBody = document.getElementById('feature-panel-body');
    const featurePanelResizer = document.getElementById('feature-panel-resizer');
    const agentContextMenu = document.getElementById('agent-context-menu');
    const deleteAgentAction = document.getElementById('delete-agent-action');
    const followLatestButton = document.getElementById('follow-latest-btn');
    const railButtons = Array.from(document.querySelectorAll('.rail-button'));
    const languageToggle = document.getElementById('language-toggle');
    const themeToggle = document.getElementById('theme-toggle');

    let currentAgentId = null;
    let allAgents = [];
    let currentMessages = [];
    let currentInputRequests = [];
    let toolRenderConfigs = {};
    let TOOL_NAMES = {};
    let contextMenuAgentId = null;
    let activeFeaturePanel = null;
    let featurePanelWidth = 320;
    let currentTheme = localStorage.getItem('agentdev-theme') || 'dark';
    let currentLanguage = localStorage.getItem('agentdev-language') || 'zh';
    let currentHookInspector = { lifecycleOrder: [], features: [], hooks: [] };
    let currentHookInspectorSignature = '';
    let currentOverviewSnapshot = getEmptyOverviewSnapshot();
    let currentOverviewSignature = '';
    let currentLogs = [];
    let currentLogsSignature = '';
    let currentMcpInfo = null;
    let logPanelScope = 'current';
    let logFilters = {
      search: '',
      level: 'all',
      feature: 'all',
      lifecycle: 'all',
    };
    let selectedOverviewLifecycle = 'StepFinish';
    let selectedFeatureName = null;
    let followLatestEnabled = true;
    let suppressFollowScrollEvent = false;
    let pendingFollowToBottom = false;
    let lastManualScrollIntentAt = 0;
    let followScrollSettleToken = 0;

    const I18N = {
      zh: {
        page_title: 'Agent 调试器',
        sidebar_toggle: '切换侧栏',
        resize_panel: '调整面板宽度',
        chars: '字符',
        status_connected: '已连接',
        status_disconnected: '已断开',
        status_no_agent: '无 Agent',
        empty_waiting: '等待消息中...',
        panel_hint: '选择右侧功能按钮以展开面板。',
        panel_structure: '结构',
        panel_monitor: '监视',
        panel_features: '功能特性',
        panel_reverse_hooks: '反向钩子',
        panel_logs: '日志',
        panel_mcp: 'MCP',
        panel_loop_flow: '工作流',
        panel_runtime: '运行概览',
        panel_current_turn: '本轮',
        panel_session_total: '累计',
        panel_context: '上下文',
        panel_features_summary: '功能概览',
        panel_select_lifecycle: '选择一个生命周期阶段',
        panel_inspector: '检查器',
        panel_connection: '连接状态',
        panel_messages: '消息数',
        panel_usage: '用量',
        panel_features_label: '功能特性',
        panel_status_summary: '状态分布',
        panel_enabled: '已启用',
        panel_partial: '部分启用',
        panel_disabled: '已关闭',
        panel_total: '总数',
        panel_all_features: '全部功能特性',
        panel_registered: '已注册',
        panel_no_features: '没有 Feature',
        panel_no_feature_data: '当前 Agent 尚未上报 feature 信息。',
        panel_feature_details: 'Feature 详情',
        panel_loaded_tools: '已加载工具',
        panel_no_tools: '当前没有已注册工具。',
        panel_close: '关闭',
        panel_no_hook_data: '没有 Hook 数据',
        panel_no_hook_data_desc: '当前 Agent 尚未上报 feature / hook 监视信息。',
        panel_all_lifecycle_slots: '完整 8 个生命周期槽位',
        panel_attached: '已挂载',
        panel_no_handlers: '当前没有挂载任何处理函数。',
        stat_active_agent: '当前 Agent',
        stat_context_length: '上下文长度',
        stat_turn_tokens: '本轮 Tokens',
        stat_total_tokens: '累计 Tokens',
        stat_cache_hit_rate: '缓存命中率',
        stat_turn_requests: '本轮请求数',
        metric_messages: '消息数',
        metric_chars: '字符数',
        metric_turns: '轮次',
        metric_tool_calls: '工具调用',
        metric_input_tokens: '输入',
        metric_output_tokens: '输出',
        metric_requests: 'LLM 请求',
        metric_cache_hit_requests: '命中请求',
        metric_cache_miss_requests: '未命中请求',
        metric_avg_per_request: '每次平均',
        metric_cache_read: '缓存读取',
        metric_cache_write: '缓存写入',
        metric_cache_hit_rate: '命中率',
        metric_input_share: '输入占比',
        metric_output_share: '输出占比',
        metric_latest_turn: '最近一轮',
        metric_session_total: '整个会话',
        metric_no_calls: '还没有 LLM 请求',
        metric_unavailable: '暂无',
        feature_source_missing: '暂无源码信息',
        feature_enabled: 'enabled',
        feature_partial: 'partial',
        feature_disabled: 'disabled',
        feature_hooks: 'hooks',
        feature_tools: 'tools',
        feature_messages: '条消息',
        feature_registered_label: '已注册',
        feature_active_tools: '启用工具',
        feature_tool_enabled: 'enabled',
        feature_tool_disabled: 'disabled',
        feature_tool_render: 'render',
        feature_open_details: '查看详情',
        feature_status_label: '状态',
        mcp_section_kicker: 'MCP 服务器',
        mcp_hero_title: 'Debugger Hub MCP 服务',
        structure_kicker: 'ReAct 循环拓扑',
        structure_hero_title: 'Feature Hooks 映射',
        structure_subtitle: '查看当前 agent 的 hook 映射、循环阶段说明，以及用于阅读会话链路的开发者视角解释。',
        overview_kicker: '运行监视',
        overview_hero_title: 'LLM 调用监视',
        mcp_item_tool: '工具',
        mcp_item_resource: '资源',
        mcp_item_prompt: '提示模板',
        active_none: '无',
        delete_agent: '删除 Agent',
        delete_confirm: '删除这个已断开的 Agent？这只会从当前调试界面移除它的记录。',
        delete_failed: '删除 Agent 失败: ',
        theme_toggle_light: '切换到浅色模式',
        theme_toggle_dark: '切换到深色模式',
        language_toggle: '切换到英文',
        language_toggle_short: 'EN',
        structure_tooltip: '结构',
        monitor_tooltip: '监视',
        features_tooltip: '功能特性',
        reverse_hooks_tooltip: '反向钩子',
        logs_tooltip: '日志',
        mcp_tooltip: 'MCP',
        mcp_subtitle: '调试器内置的只读 MCP 服务器，可供外部客户端和 agent 自观察使用。',
        mcp_enabled: '已启用',
        mcp_disabled: '已禁用',
        mcp_endpoint: '端点',
        mcp_transport: '传输',
        mcp_tools: '工具',
        mcp_resources: '资源',
        mcp_prompts: '提示模板',
        mcp_client_config: '客户端配置',
        mcp_claude_desktop: 'Claude Desktop 配置',
        mcp_codex: 'Codex 配置',
        mcp_manual: '手动初始化示例',
        mcp_tool_list: '工具一览',
        mcp_resource_list: '资源一览',
        mcp_prompt_list: '提示模板一览',
        mcp_loading: '正在加载 MCP 信息...',
        logs_scope: '范围',
        logs_scope_current: '只看当前 Agent',
        logs_scope_all: '全部',
        logs_search: '搜索',
        logs_search_placeholder: '按消息、namespace、feature、hook 检索',
        logs_level: '级别',
        logs_level_all: '全部级别',
        logs_level_debug: 'Debug 及以上',
        logs_level_info: 'Info 及以上',
        logs_level_warn: 'Warn 及以上',
        logs_level_error: '仅 Error',
        logs_feature: 'Feature',
        logs_feature_all: '全部 Feature',
        logs_lifecycle: 'Lifecycle',
        logs_lifecycle_all: '全部生命周期',
        logs_empty: '当前筛选条件下没有日志。',
        logs_total: '日志',
        logs_details: '查看结构化数据',
        phase_thinking: '思考中',
        phase_content: '生成内容',
        phase_tool_calling: '工具调用',
        input_placeholder: '正在与 Agent 对话',
        follow_latest_on: '跟随最新',
        follow_latest_off: '回到底部',
        expand: '展开',
        collapse: '收起',
        thinking_process: '思考过程',
        hook_kind: 'hook',
        subagent: '子代理',
        subagent_done: '已完成',
        subagent_view_messages: '查看消息 >',
        delete_failed_generic: '删除失败',
        overview_subtitle: '查看上下文、Token 消耗和缓存命中等信息',
      },
      en: {
        page_title: 'Agent Debugger',
        sidebar_toggle: 'Toggle Sidebar',
        resize_panel: 'Resize panel',
        chars: 'chars',
        status_connected: 'Connected',
        status_disconnected: 'Disconnected',
        status_no_agent: 'No agent',
        empty_waiting: 'Waiting for messages...',
        panel_hint: 'Select a tool on the right rail to open the panel.',
        panel_structure: 'Structure',
        panel_monitor: 'Monitor',
        panel_features: 'Features',
        panel_reverse_hooks: 'Reverse Hooks',
        panel_logs: 'Logs',
        panel_mcp: 'MCP',
        panel_loop_flow: 'Workflow',
        panel_runtime: 'Runtime Overview',
        panel_current_turn: 'Current Turn',
        panel_session_total: 'Session Total',
        panel_context: 'Context',
        panel_features_summary: 'Feature Summary',
        panel_select_lifecycle: 'Select a lifecycle stage',
        panel_inspector: 'Inspector',
        panel_connection: 'Connection',
        panel_messages: 'Messages',
        panel_usage: 'Usage',
        panel_features_label: 'Features',
        panel_status_summary: 'Status Mix',
        panel_enabled: 'enabled',
        panel_partial: 'partial',
        panel_disabled: 'disabled',
        panel_total: 'total',
        panel_all_features: 'All Features',
        panel_registered: 'registered',
        panel_no_features: 'No Features',
        panel_no_feature_data: 'The current agent has not reported feature metadata yet.',
        panel_feature_details: 'Feature Details',
        panel_loaded_tools: 'Loaded Tools',
        panel_no_tools: 'No tools are currently registered for this feature.',
        panel_close: 'Close',
        panel_no_hook_data: 'No Hook Data',
        panel_no_hook_data_desc: 'The current agent has not reported any feature / hook inspector data yet.',
        panel_all_lifecycle_slots: 'All 8 lifecycle slots',
        panel_attached: 'attached',
        panel_no_handlers: 'No attached handlers.',
        stat_active_agent: 'Active Agent',
        stat_context_length: 'Context Length',
        stat_turn_tokens: 'Turn Tokens',
        stat_total_tokens: 'Total Tokens',
        stat_cache_hit_rate: 'Cache Hit Rate',
        stat_turn_requests: 'Turn Requests',
        metric_messages: 'Messages',
        metric_chars: 'Characters',
        metric_turns: 'Turns',
        metric_tool_calls: 'Tool Calls',
        metric_input_tokens: 'Input',
        metric_output_tokens: 'Output',
        metric_requests: 'LLM Requests',
        metric_cache_hit_requests: 'Hit Requests',
        metric_cache_miss_requests: 'Miss Requests',
        metric_avg_per_request: 'Avg / Request',
        metric_cache_read: 'Cache Read',
        metric_cache_write: 'Cache Write',
        metric_cache_hit_rate: 'Hit Rate',
        metric_input_share: 'Input Share',
        metric_output_share: 'Output Share',
        metric_latest_turn: 'Latest Turn',
        metric_session_total: 'Whole Session',
        metric_no_calls: 'No LLM requests yet',
        metric_unavailable: 'N/A',
        feature_source_missing: 'No source metadata',
        feature_enabled: 'enabled',
        feature_partial: 'partial',
        feature_disabled: 'disabled',
        feature_hooks: 'hooks',
        feature_tools: 'tools',
        feature_messages: 'messages',
        feature_registered_label: 'registered',
        feature_active_tools: 'Active Tools',
        feature_tool_enabled: 'enabled',
        feature_tool_disabled: 'disabled',
        feature_tool_render: 'render',
        feature_open_details: 'Open details',
        feature_status_label: 'Status',
        mcp_section_kicker: 'Model Context Protocol',
        mcp_hero_title: 'Debugger MCP Server',
        structure_kicker: 'ReAct Loop Topology',
        structure_hero_title: 'Feature Hooks Map',
        structure_subtitle: 'Inspect the current agent hook map, loop timing guide, and developer-facing explanations for reading the session flow.',
        overview_kicker: 'Runtime Monitor',
        overview_hero_title: 'Current turn, totals, and cache at a glance',
        mcp_item_tool: 'tool',
        mcp_item_resource: 'resource',
        mcp_item_prompt: 'prompt',
        active_none: 'None',
        delete_agent: 'Delete Agent',
        delete_confirm: 'Delete this disconnected agent? This only removes it from the current debugger view.',
        delete_failed: 'Failed to delete agent: ',
        theme_toggle_light: 'Switch to light mode',
        theme_toggle_dark: 'Switch to dark mode',
        language_toggle: 'Switch to Chinese',
        language_toggle_short: '中',
        structure_tooltip: 'Structure',
        monitor_tooltip: 'Monitor',
        features_tooltip: 'Features',
        reverse_hooks_tooltip: 'Reverse Hooks',
        logs_tooltip: 'Logs',
        mcp_tooltip: 'MCP',
        mcp_subtitle: 'Built-in read-only MCP server for external clients and agent self-observation.',
        mcp_enabled: 'Enabled',
        mcp_disabled: 'Disabled',
        mcp_endpoint: 'Endpoint',
        mcp_transport: 'Transport',
        mcp_tools: 'Tools',
        mcp_resources: 'Resources',
        mcp_prompts: 'Prompts',
        mcp_client_config: 'Client Config',
        mcp_claude_desktop: 'Claude Desktop config',
        mcp_codex: 'Codex config',
        mcp_manual: 'Manual initialize example',
        mcp_tool_list: 'Tool Catalog',
        mcp_resource_list: 'Resource Catalog',
        mcp_prompt_list: 'Prompt Catalog',
        mcp_loading: 'Loading MCP info...',
        logs_scope: 'Scope',
        logs_scope_current: 'Current agent',
        logs_scope_all: 'All agents',
        logs_search: 'Search',
        logs_search_placeholder: 'Search message, namespace, feature, hook',
        logs_level: 'Level',
        logs_level_all: 'All levels',
        logs_level_debug: 'Debug and up',
        logs_level_info: 'Info and up',
        logs_level_warn: 'Warn and up',
        logs_level_error: 'Error only',
        logs_feature: 'Feature',
        logs_feature_all: 'All features',
        logs_lifecycle: 'Lifecycle',
        logs_lifecycle_all: 'All lifecycles',
        logs_empty: 'No logs match the current filters.',
        logs_total: 'logs',
        logs_details: 'Structured payload',
        phase_thinking: 'Thinking',
        phase_content: 'Streaming',
        phase_tool_calling: 'Tool Calling',
        input_placeholder: 'Chatting with the agent',
        follow_latest_on: 'Following Latest',
        follow_latest_off: 'Jump to Latest',
        expand: 'Expand',
        collapse: 'Collapse',
        thinking_process: 'Thinking Process',
        hook_kind: 'hook',
        subagent: 'SubAgent',
        subagent_done: 'Completed',
        subagent_view_messages: 'View messages >',
        delete_failed_generic: 'Delete failed',
        overview_subtitle: 'Separate current context, current-turn usage, session totals, and request-level cache hits so each metric means exactly one thing.',
      },
    };

    function t(key) {
      const table = I18N[currentLanguage] || I18N.zh;
      return table[key] || key;
    }

    function getFeatureStatus(feature) {
      return feature && feature.status ? feature.status : (feature && feature.enabled ? 'enabled' : 'partial');
    }

    function getFeatureStatusLabel(status) {
      if (status === 'disabled') return t('feature_disabled');
      if (status === 'partial') return t('feature_partial');
      return t('feature_enabled');
    }

    function getStatusBadgeClass(status) {
      return 'feature-badge status-' + escapeHtml(status || 'enabled');
    }

    function getEmptyStateHtml() {
      return '<div class="empty-state">' + escapeHtml(t('empty_waiting')) + '</div>';
    }

    function getFeaturePanelEmptyHtml() {
      return '<div class="feature-panel-empty"><div>' + escapeHtml(t('panel_hint')) + '</div></div>';
    }

    function getToggleButtonLabel(collapsed) {
      return collapsed
        ? '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> ' + escapeHtml(t('expand'))
        : '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> ' + escapeHtml(t('collapse'));
    }

    function isNearBottom() {
      const threshold = 48;
      return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
    }

    function updateFollowLatestButton() {
      if (!followLatestButton) return;
      const hasMessages = currentMessages.length > 0;
      followLatestButton.classList.toggle('hidden', !hasMessages);
      followLatestButton.classList.toggle('active', followLatestEnabled);
      followLatestButton.innerHTML =
        '<span class="follow-latest-dot"></span><span>' +
        escapeHtml(t(followLatestEnabled ? 'follow_latest_on' : 'follow_latest_off')) +
        '</span>';
    }

    function markManualScrollIntent() {
      lastManualScrollIntentAt = Date.now();
    }

    function hasRecentManualScrollIntent() {
      return Date.now() - lastManualScrollIntentAt < 500;
    }

    function animateScrollTo(targetTop, duration = 150) {
      const settleToken = ++followScrollSettleToken;
      lastManualScrollIntentAt = 0;
      suppressFollowScrollEvent = true;

      const startTop = container.scrollTop;
      const delta = targetTop - startTop;
      if (Math.abs(delta) < 1 || duration <= 0) {
        container.scrollTop = targetTop;
        suppressFollowScrollEvent = false;
        return;
      }

      const startAt = performance.now();
      const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

      const step = (now) => {
        if (settleToken !== followScrollSettleToken) {
          return;
        }

        const progress = Math.min(1, (now - startAt) / duration);
        container.scrollTop = startTop + delta * easeOutCubic(progress);

        if (progress < 1) {
          requestAnimationFrame(step);
          return;
        }

        container.scrollTop = targetTop;
        suppressFollowScrollEvent = false;
      };

      requestAnimationFrame(step);
    }

    function scrollToLatest(behavior = 'smooth') {
      const targetTop = container.scrollHeight;
      if (behavior === 'auto') {
        followScrollSettleToken += 1;
        lastManualScrollIntentAt = 0;
        suppressFollowScrollEvent = true;
        container.scrollTop = targetTop;
        suppressFollowScrollEvent = false;
        return;
      }

      animateScrollTo(targetTop, 70);
    }

    function setFollowLatest(enabled, options = {}) {
      const { scroll = false, behavior = 'smooth' } = options;
      followLatestEnabled = enabled;
      if (enabled) {
        lastManualScrollIntentAt = 0;
      }
      updateFollowLatestButton();
      if (enabled && scroll) {
        scrollToLatest(behavior);
      }
    }

    function scheduleScrollToLatest(behavior = 'smooth') {
      pendingFollowToBottom = true;
      requestAnimationFrame(() => {
        if (!pendingFollowToBottom) return;
        pendingFollowToBottom = false;
        scrollToLatest(behavior);
      });
    }

    function shortenSourcePath(value) {
      if (!value) return '';
      const normalized = String(value).replace(/\\\\/g, '/');
      const srcIndex = normalized.lastIndexOf('/src/');
      if (srcIndex >= 0) return normalized.slice(srcIndex + 1);
      const agentdevIndex = normalized.lastIndexOf('/AgentDev/');
      if (agentdevIndex >= 0) return normalized.slice(agentdevIndex + 10);
      return normalized;
    }

    const FULL_HOOK_LIFECYCLE_ORDER = [
      'AgentInitiate',
      'AgentDestroy',
      'CallStart',
      'CallFinish',
      'StepStart',
      'StepFinish',
      'ToolUse',
      'ToolFinished',
    ];

    function getHookInspectorSignature(snapshot) {
      return JSON.stringify(snapshot || { lifecycleOrder: [], features: [], hooks: [] });
    }

    function getEmptyOverviewSnapshot() {
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
      };
    }

    function normalizeOverviewSnapshot(snapshot) {
      const empty = getEmptyOverviewSnapshot();
      if (!snapshot || typeof snapshot !== 'object') {
        return empty;
      }

      return {
        updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0,
        context: {
          messageCount: typeof snapshot.context?.messageCount === 'number' ? snapshot.context.messageCount : 0,
          charCount: typeof snapshot.context?.charCount === 'number' ? snapshot.context.charCount : 0,
          toolCallCount: typeof snapshot.context?.toolCallCount === 'number' ? snapshot.context.toolCallCount : 0,
          turnCount: typeof snapshot.context?.turnCount === 'number' ? snapshot.context.turnCount : 0,
        },
        usageStats: {
          totalUsage: {
            inputTokens: typeof snapshot.usageStats?.totalUsage?.inputTokens === 'number' ? snapshot.usageStats.totalUsage.inputTokens : 0,
            outputTokens: typeof snapshot.usageStats?.totalUsage?.outputTokens === 'number' ? snapshot.usageStats.totalUsage.outputTokens : 0,
            totalTokens: typeof snapshot.usageStats?.totalUsage?.totalTokens === 'number' ? snapshot.usageStats.totalUsage.totalTokens : 0,
            cacheCreationTokens: typeof snapshot.usageStats?.totalUsage?.cacheCreationTokens === 'number' ? snapshot.usageStats.totalUsage.cacheCreationTokens : 0,
            cacheReadTokens: typeof snapshot.usageStats?.totalUsage?.cacheReadTokens === 'number' ? snapshot.usageStats.totalUsage.cacheReadTokens : 0,
            reasoningTokens: typeof snapshot.usageStats?.totalUsage?.reasoningTokens === 'number' ? snapshot.usageStats.totalUsage.reasoningTokens : 0,
            audioTokens: typeof snapshot.usageStats?.totalUsage?.audioTokens === 'number' ? snapshot.usageStats.totalUsage.audioTokens : 0,
          },
          calls: Array.isArray(snapshot.usageStats?.calls) ? snapshot.usageStats.calls.map((call) => ({
            ...call,
            cacheHitRequests: typeof call?.cacheHitRequests === 'number' ? call.cacheHitRequests : 0,
          })) : [],
          totalRequests: typeof snapshot.usageStats?.totalRequests === 'number' ? snapshot.usageStats.totalRequests : 0,
          totalCacheHitRequests: typeof snapshot.usageStats?.totalCacheHitRequests === 'number' ? snapshot.usageStats.totalCacheHitRequests : 0,
        },
      };
    }

    function getOverviewSignature(snapshot) {
      return JSON.stringify(normalizeOverviewSnapshot(snapshot));
    }

    function normalizeHookInspector(snapshot) {
      const raw = snapshot || { lifecycleOrder: [], features: [], hooks: [] };
      const hookMap = new Map((raw.hooks || []).map(group => [group.lifecycle, group]));
      return {
        lifecycleOrder: FULL_HOOK_LIFECYCLE_ORDER.slice(),
        features: (raw.features || []).map(feature => ({
          ...feature,
          tools: feature.tools || [],
        })),
        hooks: FULL_HOOK_LIFECYCLE_ORDER.map((lifecycle) => {
          const existing = hookMap.get(lifecycle);
          if (existing) return existing;
          return {
            lifecycle,
            kind: lifecycle === 'StepFinish' || lifecycle === 'ToolUse' ? 'decision' : 'notify',
            entries: [],
          };
        }),
      };
    }

    function setCurrentHookInspector(snapshot) {
      const normalized = normalizeHookInspector(snapshot);
      currentHookInspector = normalized;
      currentHookInspectorSignature = getHookInspectorSignature(normalized);
      if (selectedFeatureName && !normalized.features.some(feature => feature.name === selectedFeatureName)) {
        selectedFeatureName = null;
      }
    }

    function setCurrentOverviewSnapshot(snapshot) {
      const normalized = normalizeOverviewSnapshot(snapshot);
      currentOverviewSnapshot = normalized;
      currentOverviewSignature = getOverviewSignature(normalized);
    }

    function setCurrentLogs(logs) {
      currentLogs = Array.isArray(logs) ? logs : [];
      currentLogsSignature = JSON.stringify({
        count: currentLogs.length,
        last: currentLogs.length > 0 ? currentLogs[currentLogs.length - 1].id : null,
      });
    }

    function formatMetricNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '0';
      }
      return value.toLocaleString();
    }

    function formatRate(numerator, denominator) {
      if (!denominator) {
        return '0%';
      }
      return Math.round((numerator / denominator) * 100) + '%';
    }

    function getLatestCallSummary(overview) {
      const calls = Array.isArray(overview?.usageStats?.calls) ? overview.usageStats.calls : [];
      if (calls.length === 0) return null;
      return calls.slice().sort((a, b) => (a.callIndex || 0) - (b.callIndex || 0))[calls.length - 1];
    }

    function getUsageBreakdown(summary, fallbackRequests = 0) {
      const totalUsage = summary?.totalUsage || {};
      const totalTokens = totalUsage.totalTokens || 0;
      const inputTokens = totalUsage.inputTokens || 0;
      const outputTokens = totalUsage.outputTokens || 0;
      const requests = typeof summary?.stepCount === 'number'
        ? summary.stepCount
        : fallbackRequests;
      const cacheHitRequests = typeof summary?.cacheHitRequests === 'number'
        ? summary.cacheHitRequests
        : 0;

      return {
        inputTokens,
        outputTokens,
        totalTokens,
        requests,
        cacheHitRequests,
        cacheMissRequests: Math.max(0, requests - cacheHitRequests),
        cacheHitRate: formatRate(cacheHitRequests, requests),
        avgPerRequest: requests > 0 ? Math.round(totalTokens / requests) : 0,
        cacheReadTokens: totalUsage.cacheReadTokens || 0,
        cacheCreationTokens: totalUsage.cacheCreationTokens || 0,
        inputShare: totalTokens > 0 ? Math.round((inputTokens / totalTokens) * 100) : 0,
        outputShare: totalTokens > 0 ? Math.round((outputTokens / totalTokens) * 100) : 0,
      };
    }

    function renderTokenBar(inputTokens, outputTokens) {
      const total = inputTokens + outputTokens;
      const inputWidth = total > 0 ? (inputTokens / total) * 100 : 50;
      const outputWidth = total > 0 ? (outputTokens / total) * 100 : 50;
      return [
        '<div class="usage-bar">',
        '<div class="usage-bar-fill input" style="width:' + inputWidth + '%"></div>',
        '<div class="usage-bar-fill output" style="width:' + outputWidth + '%"></div>',
        '</div>',
      ].join('');
    }

    function renderRateRing(percent, label, meta) {
      const safePercent = Math.max(0, Math.min(100, percent));
      return [
        '<div class="rate-ring-card">',
        '<div class="rate-ring" style="--ring-percent:' + safePercent + ';">',
        '<div class="rate-ring-inner">',
        '<div class="rate-ring-value">' + safePercent + '%</div>',
        '<div class="rate-ring-label">' + escapeHtml(label) + '</div>',
        '</div>',
        '</div>',
        '<div class="rate-ring-meta">' + escapeHtml(meta) + '</div>',
        '</div>',
      ].join('');
    }

    function renderUsageCard(title, summaryLabel, breakdown) {
      return [
        '<div class="usage-card">',
        '<div class="usage-card-header">',
        '<div>',
        '<div class="usage-card-title">' + escapeHtml(title) + '</div>',
        '<div class="usage-card-subtitle">' + escapeHtml(summaryLabel) + '</div>',
        '</div>',
        '<div class="usage-card-total">' + formatMetricNumber(breakdown.totalTokens) + '</div>',
        '</div>',
        renderTokenBar(breakdown.inputTokens, breakdown.outputTokens),
        '<div class="usage-split-legend">',
        '<span><i class="legend-dot input"></i>' + escapeHtml(t('metric_input_tokens')) + ' ' + formatMetricNumber(breakdown.inputTokens) + '</span>',
        '<span><i class="legend-dot output"></i>' + escapeHtml(t('metric_output_tokens')) + ' ' + formatMetricNumber(breakdown.outputTokens) + '</span>',
        '</div>',
        '<div class="usage-stat-grid">',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.requests) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_avg_per_request')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.avgPerRequest) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_input_share')) + '</div><div class="usage-stat-cell-value">' + breakdown.inputShare + '%</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_output_share')) + '</div><div class="usage-stat-cell-value">' + breakdown.outputShare + '%</div></div>',
        '</div>',
        '</div>',
      ].join('');
    }

    function renderCacheCard(title, breakdown) {
      const percent = breakdown.requests > 0
        ? Math.round((breakdown.cacheHitRequests / breakdown.requests) * 100)
        : 0;
      return [
        '<div class="usage-card cache-card">',
        '<div class="usage-card-header">',
        '<div class="usage-card-title">' + escapeHtml(title) + '</div>',
        '<div class="usage-card-subtitle">' + escapeHtml(t('metric_cache_hit_rate')) + '</div>',
        '</div>',
        renderRateRing(percent, t('metric_cache_hit_rate'), breakdown.cacheHitRequests + ' / ' + breakdown.requests),
        '<div class="usage-stat-grid">',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_hit_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheHitRequests) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_miss_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheMissRequests) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_read')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheReadTokens) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_write')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheCreationTokens) + '</div></div>',
        '</div>',
        '</div>',
      ].join('');
    }

    function renderContextChip(label, value, meta) {
      return [
        '<div class="context-chip">',
        '<div class="context-chip-label">' + escapeHtml(label) + '</div>',
        '<div class="context-chip-value">' + escapeHtml(value) + '</div>',
        '<div class="context-chip-meta">' + escapeHtml(meta) + '</div>',
        '</div>',
      ].join('');
    }

    function setCurrentMcpInfo(info) {
      currentMcpInfo = info || null;
    }

    function getLevelWeight(level) {
      const weights = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
      return weights[level] || 0;
    }

    function formatLogTimestamp(timestamp) {
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      });
    }

    function safePrettyJson(value) {
      try {
        return JSON.stringify(value, null, 2);
      } catch (e) {
        return String(value);
      }
    }

    function getFilteredLogs() {
      const search = logFilters.search.trim().toLowerCase();
      const minLevel = logFilters.level;
      return currentLogs.filter((entry) => {
        if (minLevel !== 'all' && getLevelWeight(entry.level) < getLevelWeight(minLevel)) {
          return false;
        }
        if (logFilters.feature !== 'all' && (entry.context?.feature || 'none') !== logFilters.feature) {
          return false;
        }
        if (logFilters.lifecycle !== 'all' && (entry.context?.lifecycle || 'none') !== logFilters.lifecycle) {
          return false;
        }
        if (search) {
          const haystack = [
            entry.message,
            entry.namespace,
            entry.context?.feature,
            entry.context?.lifecycle,
            entry.context?.hookMethod,
            entry.context?.toolName,
            entry.context?.agentName,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(search)) {
            return false;
          }
        }
        return true;
      });
    }

    function renderLogsPanel() {
      const filteredLogs = getFilteredLogs().slice().reverse();
      const featureOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.feature).filter(Boolean))).sort();
      const lifecycleOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.lifecycle).filter(Boolean))).sort();

      const toolbar = [
        '<section class="log-toolbar">',
        '<div class="log-filter-row">',
        '<div class="log-filter-label">' + escapeHtml(t('logs_scope')) + '</div>',
        '<div class="log-chip-group">',
        '<button type="button" class="log-chip' + (logPanelScope === 'current' ? ' active' : '') + '" onclick="window.setLogPanelScope(&quot;current&quot;)">' + escapeHtml(t('logs_scope_current')) + '</button>',
        '<button type="button" class="log-chip' + (logPanelScope === 'all' ? ' active' : '') + '" onclick="window.setLogPanelScope(&quot;all&quot;)">' + escapeHtml(t('logs_scope_all')) + '</button>',
        '</div>',
        '</div>',
        '<div class="log-filter-row">',
        '<div class="log-filter-label">' + escapeHtml(t('logs_search')) + '</div>',
        '<input class="log-input" type="text" value="' + escapeHtml(logFilters.search) + '" placeholder="' + escapeHtml(t('logs_search_placeholder')) + '" oninput="window.updateLogFilter(&quot;search&quot;, this.value)">',
        '</div>',
        '<div class="log-filter-row">',
        '<div class="log-filter-label">' + escapeHtml(t('logs_level')) + '</div>',
        '<select class="log-select" onchange="window.updateLogFilter(&quot;level&quot;, this.value)">',
        '<option value="all"' + (logFilters.level === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_all')) + '</option>',
        '<option value="debug"' + (logFilters.level === 'debug' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_debug')) + '</option>',
        '<option value="info"' + (logFilters.level === 'info' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_info')) + '</option>',
        '<option value="warn"' + (logFilters.level === 'warn' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_warn')) + '</option>',
        '<option value="error"' + (logFilters.level === 'error' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_error')) + '</option>',
        '</select>',
        '<select class="log-select" onchange="window.updateLogFilter(&quot;feature&quot;, this.value)">',
        '<option value="all"' + (logFilters.feature === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_feature_all')) + '</option>',
        featureOptions.map((feature) => '<option value="' + escapeHtml(feature) + '"' + (logFilters.feature === feature ? ' selected' : '') + '>' + escapeHtml(feature) + '</option>').join(''),
        '</select>',
        '<select class="log-select" onchange="window.updateLogFilter(&quot;lifecycle&quot;, this.value)">',
        '<option value="all"' + (logFilters.lifecycle === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_lifecycle_all')) + '</option>',
        lifecycleOptions.map((lifecycle) => '<option value="' + escapeHtml(lifecycle) + '"' + (logFilters.lifecycle === lifecycle ? ' selected' : '') + '>' + escapeHtml(lifecycle) + '</option>').join(''),
        '</select>',
        '</div>',
        '<div class="log-summary"><span>' + String(filteredLogs.length) + ' ' + escapeHtml(t('logs_total')) + '</span><span>' + escapeHtml(logPanelScope === 'current' ? (allAgents.find((agent) => agent.id === currentAgentId)?.name || t('active_none')) : t('logs_scope_all')) + '</span></div>',
        '</section>',
      ].join('');

      if (filteredLogs.length === 0) {
        return '<div class="log-panel">' + toolbar + '<div class="feature-panel-empty"><div>' + escapeHtml(t('logs_empty')) + '</div></div></div>';
      }

      const rows = filteredLogs.map((entry) => {
        const metaPills = [
          entry.context?.agentName ? '<span class="log-pill">' + escapeHtml(entry.context.agentName) + '</span>' : '',
          entry.context?.feature ? '<span class="log-pill">feature:' + escapeHtml(entry.context.feature) + '</span>' : '',
          entry.context?.lifecycle ? '<span class="log-pill">hook:' + escapeHtml(entry.context.lifecycle) + '</span>' : '',
          entry.context?.hookMethod ? '<span class="log-pill">' + escapeHtml(entry.context.hookMethod) + '()</span>' : '',
          entry.context?.toolName ? '<span class="log-pill">tool:' + escapeHtml(entry.context.toolName) + '</span>' : '',
          typeof entry.context?.step === 'number' ? '<span class="log-pill">step ' + String(entry.context.step) + '</span>' : '',
          typeof entry.context?.callIndex === 'number' ? '<span class="log-pill">call ' + String(entry.context.callIndex) + '</span>' : '',
        ].filter(Boolean).join('');

        const detailBlock = entry.data !== undefined
          ? '<details class="log-details"><summary>' + escapeHtml(t('logs_details')) + '</summary><pre>' + escapeHtml(safePrettyJson(entry.data)) + '</pre></details>'
          : '';

        return [
          '<article class="log-card">',
          '<div class="log-card-head">',
          '<div class="log-card-main">',
          '<span class="log-level ' + escapeHtml(entry.level) + '">' + escapeHtml(entry.level) + '</span>',
          '<span class="log-namespace">' + escapeHtml(entry.namespace) + '</span>',
          '</div>',
          '<div class="log-timestamp">' + escapeHtml(formatLogTimestamp(entry.timestamp)) + '</div>',
          '</div>',
          '<div class="log-card-body">',
          '<div class="log-message">' + escapeHtml(entry.message) + '</div>',
          metaPills ? '<div class="log-meta">' + metaPills + '</div>' : '',
          detailBlock,
          '</div>',
          '</article>',
        ].join('');
      }).join('');

      return '<div class="log-panel">' + toolbar + '<section class="log-list">' + rows + '</section></div>';
    }

    function renderMcpItems(items, typeLabel) {
      if (!Array.isArray(items) || items.length === 0) {
        return '<div class="feature-panel-empty"><div>' + escapeHtml(t('active_none')) + '</div></div>';
      }

      return '<div class="mcp-list">' + items.map((item) => {
        const name = item.name || item.uri || '';
        return [
        '<article class="mcp-item">',
        '<div class="mcp-item-head">',
        '<div class="mcp-item-name">' + escapeHtml(name) + '</div>',
        '<div class="mcp-item-type">' + escapeHtml(typeLabel) + '</div>',
        '</div>',
          '<div class="mcp-item-desc">' + escapeHtml(item.description || '') + '</div>',
          '</article>',
        ].join('');
      }).join('') + '</div>';
    }

    function renderMcpPanel() {
      if (!currentMcpInfo) {
        return '<div class="feature-panel-empty"><div>' + escapeHtml(t('mcp_loading')) + '</div></div>';
      }

      const info = currentMcpInfo;
      return [
        '<div class="mcp-panel">',
        '<section class="mcp-hero">',
        '<div class="hooks-kicker">' + escapeHtml(t('mcp_section_kicker')) + '</div>',
        '<div class="hooks-hero-title">' + escapeHtml(t('mcp_hero_title')) + '</div>',
        '<div class="hooks-hero-subtitle">' + escapeHtml(t('mcp_subtitle')) + '</div>',
        '<div class="mcp-status-pill">' + escapeHtml(info.enabled ? t('mcp_enabled') : t('mcp_disabled')) + '</div>',
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('panel_inspector')) + '</div>',
        '<div class="mcp-grid">',
        '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_endpoint')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.endpoint || '') + '</div></div>',
        '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_transport')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.transport || '') + '</div></div>',
        '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_tools')) + '</div><div class="mcp-stat-value">' + String((info.tools || []).length) + '</div></div>',
        '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_resources')) + '</div><div class="mcp-stat-value">' + String((info.resources || []).length) + '</div></div>',
        '</div>',
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_client_config')) + '</div>',
        '<div class="mcp-item-desc" style="margin-bottom:8px;">' + escapeHtml(t('mcp_claude_desktop')) + '</div>',
        '<pre class="mcp-code">' + escapeHtml(safePrettyJson(info.commands?.claudeDesktop?.json || {})) + '</pre>',
        '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(t('mcp_codex')) + '</div>',
        '<pre class="mcp-code">' + escapeHtml(safePrettyJson(info.commands?.codex?.json || {})) + '</pre>',
        '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(t('mcp_manual')) + '</div>',
        '<pre class="mcp-code">' + escapeHtml(info.commands?.curlInitialize || '') + '</pre>',
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_tool_list')) + '</div>',
        renderMcpItems(info.tools || [], t('mcp_item_tool')),
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_resource_list')) + '</div>',
        renderMcpItems(info.resources || [], t('mcp_item_resource')),
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_prompt_list')) + '</div>',
        renderMcpItems(info.prompts || [], t('mcp_item_prompt')),
        '</section>',
        '</div>',
      ].join('');
    }

    const lifecycleDocs = {
      AgentInitiate: {
        title: { zh: 'Agent 初始化阶段', en: 'Agent initialization phase' },
        body: {
          zh: [
          '这个时机只会在 agent 第一次真正进入工作状态时触发一次，适合做长生命周期资源的准备工作，比如启动后台服务、建立连接、预热缓存，或者把框架级能力挂进运行环境。',
          '',
          '~~~ts',
          '@AgentInitiate',
          'async boot(ctx) {',
          '  await this.indexWorkspace();',
          '  await this.startObserver();',
          '}',
          '~~~',
          '',
          '如果某个 feature 要在整个会话期间维持状态，这里通常是它最稳妥的切入点。相比 CallStart，它不会被每次用户输入重复触发。',
        ].join('\\n'),
          en: [
          'This moment fires only once when the agent truly enters its working state. It is the right place for long-lived setup such as booting background services, opening connections, warming caches, or mounting framework-level helpers.',
          '',
          '~~~ts',
          '@AgentInitiate',
          'async boot(ctx) {',
          '  await this.indexWorkspace();',
          '  await this.startObserver();',
          '}',
          '~~~',
          '',
          'If a feature needs to hold state across the whole session, this is usually the safest insertion point. Unlike CallStart, it is not repeated on every user request.',
        ].join('\\n'),
        },
      },
      AgentDestroy: {
        title: { zh: 'Agent 销毁阶段', en: 'Agent destroy phase' },
        body: { zh: [
          '这是 agent 生命周期的收尾点，用来释放外部资源、停止后台线程、断开连接，以及把调试信息或缓存安全落盘。',
          '',
          '~~~ts',
          '@AgentDestroy',
          'async cleanup() {',
          '  await this.workerPool.stop();',
          '  await this.cache.flush();',
          '}',
          '~~~',
          '',
          '如果一个 feature 在 AgentInitiate 做了重量级初始化，就应该在这里成对地清理掉。',
        ].join('\\n'),
          en: [
          'This is the closing stage of the agent lifecycle. Use it to release external resources, stop workers, close connections, and flush traces or caches safely to disk.',
          '',
          '~~~ts',
          '@AgentDestroy',
          'async cleanup() {',
          '  await this.workerPool.stop();',
          '  await this.cache.flush();',
          '}',
          '~~~',
          '',
          'If a feature performs heavyweight setup in AgentInitiate, it should usually tear that work down here.',
        ].join('\\n') },
      },
      CallStart: {
        title: { zh: 'Call 开始前', en: 'Before call start' },
        body: { zh: [
          '这个时机发生在系统提示词之后、用户输入正式写入上下文之前。它非常适合做输入重写、前置注入和会话级别的轻量整理。',
          '',
          '~~~ts',
          '@CallStart',
          'async rewriteInput(ctx) {',
          '  const raw = ctx.agent?.getUserInput() ?? ctx.input;',
          '  ctx.agent?.setUserInput(raw.trim());',
          '}',
          '~~~',
          '',
          '如果你想观察 feature 如何“提前影响”一次调用，这里通常是最有解释力的节点。',
        ].join('\\n'),
          en: [
          'This timing happens after the system prompt is ready but before the user input is committed into context. It is ideal for input rewriting, pre-injection, and lightweight call-level normalization.',
          '',
          '~~~ts',
          '@CallStart',
          'async rewriteInput(ctx) {',
          '  const raw = ctx.agent?.getUserInput() ?? ctx.input;',
          '  ctx.agent?.setUserInput(raw.trim());',
          '}',
          '~~~',
          '',
          'If you want to explain how a feature affects a call before the model sees it, this is usually the clearest node.',
        ].join('\\n') },
      },
      CallFinish: {
        title: { zh: 'Call 结束后', en: 'After call finish' },
        body: { zh: [
          '这是一次完整调用结束后的结算点。适合做摘要、记录、指标更新、落日志，而不适合决定下一轮 ReAct 要不要继续。',
          '',
          '~~~ts',
          '@CallFinish',
          'async afterCall(ctx) {',
          '  this.metrics.track(ctx.completed, ctx.steps);',
          '}',
          '~~~',
          '',
          '它更像“回合总结”，而不是流程控制点。',
        ].join('\\n'),
          en: [
          'This is the settlement point after a full call completes. It fits summarization, logging, and metrics updates, but it is not the place to decide whether the next ReAct turn should continue.',
          '',
          '~~~ts',
          '@CallFinish',
          'async afterCall(ctx) {',
          '  this.metrics.track(ctx.completed, ctx.steps);',
          '}',
          '~~~',
          '',
          'It behaves more like an end-of-call summary than a flow-control decision point.',
        ].join('\\n') },
      },
      StepStart: {
        title: { zh: 'Step 开始前', en: 'Before step start' },
        body: { zh: [
          '每轮 ReAct 循环刚开始时都会进入这里。适合做上下文补丁、提醒注入、局部状态同步。这类钩子往往会高频出现。',
          '',
          '~~~ts',
          '@StepStart',
          'async injectReminder(ctx) {',
          '  if (this.shouldRemind()) {',
          '    ctx.context.add({ role: "system", content: this.reminder });',
          '  }',
          '}',
          '~~~',
          '',
          '因为它会在每一轮执行，所以调试器里把它单独看出来很重要，否则很难解释某些系统消息为什么总会出现。',
        ].join('\\n'),
          en: [
          'Every ReAct iteration enters here right at the beginning. It is useful for context patching, reminder injection, and local state synchronization. These hooks often run at high frequency.',
          '',
          '~~~ts',
          '@StepStart',
          'async injectReminder(ctx) {',
          '  if (this.shouldRemind()) {',
          '    ctx.context.add({ role: "system", content: this.reminder });',
          '  }',
          '}',
          '~~~',
          '',
          'Because it runs every round, surfacing it clearly in the debugger is important; otherwise it is hard to explain why some system messages keep appearing.',
        ].join('\\n') },
      },
      StepFinish: {
        title: { zh: 'Step 结束决策点', en: 'Step finish decision point' },
        body: { zh: [
          '这是 ReAct 循环里最关键的控制点之一。模型和工具都跑完后，feature 可以在这里决定“继续下一轮”还是“就地结束”。',
          '',
          '~~~ts',
          '@StepFinish',
          'async decide(ctx) {',
          '  if (this.hasPendingDelegates()) {',
          '    return Decision.Approve;',
          '  }',
          '  return Decision.Continue;',
          '}',
          '~~~',
          '',
          '如果某个 feature 能把 agent 的循环强行维持住，通常就是在这里介入。它解释的是“为什么这轮已经看起来结束了，但系统还在继续跑”。',
        ].join('\\n'),
          en: [
          'This is one of the most important control points in the ReAct loop. After the model and tools finish, a feature can decide whether the loop should continue or end right away.',
          '',
          '~~~ts',
          '@StepFinish',
          'async decide(ctx) {',
          '  if (this.hasPendingDelegates()) {',
          '    return Decision.Approve;',
          '  }',
          '  return Decision.Continue;',
          '}',
          '~~~',
          '',
          'If a feature can keep the agent alive beyond what looks like a natural stopping point, it is usually intervening here.',
        ].join('\\n') },
      },
      ToolUse: {
        title: { zh: '工具执行前决策点', en: 'Before tool execution decision point' },
        body: { zh: [
          '这是另一个高价值观察位点。工具真正执行前，feature 可以在这里批准、拒绝或者放行。所有安全策略、危险操作拦截都很适合在这里实现。',
          '',
          '~~~ts',
          '@ToolUse',
          'async guard(ctx) {',
          '  if (ctx.call.name === "run_shell_command") {',
          '    return Decision.Deny;',
          '  }',
          '  return Decision.Continue;',
          '}',
          '~~~',
          '',
          '调试器里只要看清楚这里挂了谁，很多“为什么工具没执行”或者“为什么执行路径被改写”就能直接定位。',
        ].join('\\n'),
          en: [
          'This is another high-value inspection point. Before a tool actually runs, a feature can approve, deny, or pass it through. Security policy and dangerous-operation guards fit naturally here.',
          '',
          '~~~ts',
          '@ToolUse',
          'async guard(ctx) {',
          '  if (ctx.call.name === "run_shell_command") {',
          '    return Decision.Deny;',
          '  }',
          '  return Decision.Continue;',
          '}',
          '~~~',
          '',
          'As soon as you can see who is attached here, many "why did the tool not run?" questions become much easier to answer.',
        ].join('\\n') },
      },
      ToolFinished: {
        title: { zh: '工具执行后通知点', en: 'After tool finished notify point' },
        body: { zh: [
          '工具已经返回结果以后，这里会收到纯通知。适合做后处理、索引、同步外部状态、记录审计信息，但不会改变刚刚那次工具调用本身的结果。',
          '',
          '~~~ts',
          '@ToolFinished',
          'async record(ctx) {',
          '  this.auditTrail.push({',
          '    tool: ctx.toolName,',
          '    duration: ctx.duration,',
          '  });',
          '}',
          '~~~',
          '',
          '这类钩子更偏“旁路观察”和“后续整理”，所以通常适合完整展开给开发者查链路。',
        ].join('\\n'),
          en: [
          'Once a tool returns its result, this point receives a pure notification. It suits post-processing, indexing, external state sync, and audit recording, but it does not change the result of the tool call that already happened.',
          '',
          '~~~ts',
          '@ToolFinished',
          'async record(ctx) {',
          '  this.auditTrail.push({',
          '    tool: ctx.toolName,',
          '    duration: ctx.duration,',
          '  });',
          '}',
          '~~~',
          '',
          'These hooks are more about side-channel observation and cleanup, so they are usually worth showing in full detail to developers.',
        ].join('\\n') },
      },
    };

    function selectOverviewLifecycle(lifecycle) {
      selectedOverviewLifecycle = lifecycle;
      if (activeFeaturePanel === 'workspace') {
        renderFeaturePanel();
      }
    }

    window.selectOverviewLifecycle = selectOverviewLifecycle;

    function openFeatureDetails(featureName) {
      selectedFeatureName = featureName;
      if (activeFeaturePanel === 'hooks') {
        renderFeaturePanel();
      }
    }

    function closeFeatureDetails() {
      selectedFeatureName = null;
      if (activeFeaturePanel === 'hooks') {
        renderFeaturePanel();
      }
    }

    window.openFeatureDetails = openFeatureDetails;
    window.closeFeatureDetails = closeFeatureDetails;

    function renderStructurePanel() {
      const activeAgent = allAgents.find(agent => agent.id === currentAgentId);
      const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
      const totalHooks = currentHookInspector.hooks.reduce((sum, group) => sum + group.entries.length, 0);
      const decisionHooks = currentHookInspector.hooks.reduce(
        (sum, group) => sum + group.entries.filter(entry => entry.kind === 'decision').length,
        0
      );
      const featureStatusCounts = currentHookInspector.features.reduce((acc, feature) => {
        const status = getFeatureStatus(feature);
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, { enabled: 0, partial: 0, disabled: 0 });
      const selectedDoc = lifecycleDocs[selectedOverviewLifecycle] || lifecycleDocs.StepFinish;
      const flowChips = currentHookInspector.lifecycleOrder
        .map(name => '<button class="hooks-chip' + (name === selectedOverviewLifecycle ? ' active' : '') + '" type="button" onclick="window.selectOverviewLifecycle(&quot;' + escapeHtml(name) + '&quot;)"><strong>' + escapeHtml(name) + '</strong></button>')
        .join('');
      return [
        '<div class="hooks-panel">',
        '<section class="hooks-hero">',
        '<div class="hooks-kicker">' + escapeHtml(t('structure_kicker')) + '</div>',
        '<div class="hooks-hero-title">' + escapeHtml(t('structure_hero_title')) + '</div>',
        '<div class="hooks-hero-subtitle">' + escapeHtml(t('structure_subtitle')) + '</div>',
        '<div class="hooks-stats">',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(activeAgent ? activeAgent.name : t('active_none')) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">Hooks</div><div class="hooks-stat-value">' + String(totalHooks) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">Decision</div><div class="hooks-stat-value">' + String(decisionHooks) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('panel_features_label')) + '</div><div class="hooks-stat-value">' + String(currentHookInspector.features.length) + '</div></div>',
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_inspector')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
        '<div class="feature-grid">',
        '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_connection')) + '</div><div class="feature-card-detail"><span>' + escapeHtml(connected) + '</span><span>' + String(currentMessages.length) + ' ' + escapeHtml(t('feature_messages')) + '</span></div></div>',
        '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_features_label')) + '</div><div class="feature-card-detail"><span>' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_total')) + '</span><span>' + String(featureStatusCounts.enabled) + ' ' + escapeHtml(t('panel_enabled')) + '</span><span>' + String(featureStatusCounts.partial) + ' ' + escapeHtml(t('panel_partial')) + '</span><span>' + String(featureStatusCounts.disabled) + ' ' + escapeHtml(t('panel_disabled')) + '</span></div></div>',
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_loop_flow')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_select_lifecycle')) + '</div></div>',
        '<div class="hooks-strip">' + flowChips + '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(selectedOverviewLifecycle) + '</div><div class="hooks-section-meta">' + escapeHtml(selectedDoc.title[currentLanguage] || selectedDoc.title.zh) + '</div></div>',
        '<div class="feature-panel-section overview-doc"><div class="markdown-body">' + marked.parse(selectedDoc.body[currentLanguage] || selectedDoc.body.zh) + '</div></div>',
        '</section>',
        '</div>',
      ].join('');
    }

    function renderMonitorPanel() {
      const activeAgent = allAgents.find(agent => agent.id === currentAgentId);
      const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
      const overview = currentOverviewSnapshot || getEmptyOverviewSnapshot();
      const totalUsage = overview.usageStats?.totalUsage || {};
      const latestCall = getLatestCallSummary(overview);
      const currentBreakdown = getUsageBreakdown(latestCall, 0);
      const totalBreakdown = getUsageBreakdown({
        totalUsage,
        stepCount: overview.usageStats.totalRequests || 0,
        cacheHitRequests: overview.usageStats.totalCacheHitRequests || 0,
      }, overview.usageStats.totalRequests || 0);
      const contextLengthLabel = formatMetricNumber(overview.context.charCount) + ' chars';
      const latestTurnLabel = latestCall ? formatMetricNumber(currentBreakdown.totalTokens) : t('metric_no_calls');
      return [
        '<div class="hooks-panel">',
        '<section class="hooks-hero">',
        '<div class="hooks-kicker">' + escapeHtml(t('overview_kicker')) + '</div>',
        '<div class="hooks-hero-title">' + escapeHtml(t('overview_hero_title')) + '</div>',
        '<div class="hooks-hero-subtitle">' + escapeHtml(t('overview_subtitle')) + '</div>',
        '<div class="hooks-stats">',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(activeAgent ? activeAgent.name : t('active_none')) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_context_length')) + '</div><div class="hooks-stat-value">' + escapeHtml(contextLengthLabel) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_turn_tokens')) + '</div><div class="hooks-stat-value">' + escapeHtml(latestTurnLabel) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_cache_hit_rate')) + '</div><div class="hooks-stat-value">' + escapeHtml(totalBreakdown.cacheHitRate) + '</div></div>',
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_runtime')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
        '<div class="overview-usage-grid">',
        renderUsageCard(t('panel_current_turn'), latestCall ? t('metric_latest_turn') : t('metric_no_calls'), currentBreakdown),
        renderCacheCard(t('panel_current_turn'), currentBreakdown),
        renderUsageCard(t('panel_session_total'), t('metric_session_total'), totalBreakdown),
        renderCacheCard(t('panel_session_total'), totalBreakdown),
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_context')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_connection')) + ': ' + escapeHtml(connected) + '</div></div>',
        '<div class="context-chip-grid">',
        renderContextChip(t('metric_messages'), formatMetricNumber(overview.context.messageCount), t('panel_context')),
        renderContextChip(t('metric_chars'), formatMetricNumber(overview.context.charCount), t('stat_context_length')),
        renderContextChip(t('metric_turns'), formatMetricNumber(overview.context.turnCount), t('metric_session_total')),
        renderContextChip(t('metric_tool_calls'), formatMetricNumber(overview.context.toolCallCount), t('metric_latest_turn')),
        '</div>',
        '</section>',
        '</div>',
      ].join('');
    }

    function renderFeaturesPanel() {
      if (currentHookInspector.features.length === 0) {
        return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_features')) + '</div><div>' + escapeHtml(t('panel_no_feature_data')) + '</div></div></div>';
      }

      const selectedFeature = currentHookInspector.features.find(feature => feature.name === selectedFeatureName) || null;
      const featureCards = currentHookInspector.features
        .map(feature => {
          const status = getFeatureStatus(feature);
          return [
          '<div class="feature-card" role="button" tabindex="0" onclick="window.openFeatureDetails(&quot;' + escapeHtml(feature.name) + '&quot;)" title="' + escapeHtml(t('feature_open_details')) + '">',
          '<div class="feature-card-top">',
          '<div class="feature-card-main">',
          '<span class="feature-card-dot"></span>',
          '<div style="min-width:0;">',
          '<div class="feature-card-name">' + escapeHtml(feature.name) + '</div>',
          '<div class="feature-card-file">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + '</div>',
          '</div>',
          '</div>',
          '<div class="' + getStatusBadgeClass(status) + '">' + escapeHtml(getFeatureStatusLabel(status)) + '</div>',
          '</div>',
          '<div class="feature-card-detail">',
          '<span>' + String(feature.hookCount) + ' ' + escapeHtml(t('feature_hooks')) + '</span>',
          '<span>' + String(feature.enabledToolCount) + '/' + String(feature.toolCount) + ' ' + escapeHtml(t('feature_tools')) + '</span>',
          feature.description ? '<span>' + escapeHtml(feature.description) + '</span>' : '',
          '</div>',
          '</div>',
        ].join('');
        })
        .join('');

      const detailOverlay = selectedFeature ? [
        '<div class="feature-detail-overlay" onclick="if (event.target === this) window.closeFeatureDetails()">',
        '<div class="feature-detail-window">',
        '<div class="feature-detail-head">',
        '<div>',
        '<div class="feature-detail-title">' + escapeHtml(selectedFeature.name) + '</div>',
        '<div class="feature-detail-subtitle">' + escapeHtml(selectedFeature.description || '') + '</div>',
        '</div>',
        '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="window.closeFeatureDetails()">×</button>',
        '</div>',
        '<div class="feature-detail-stats">',
        '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_hooks')) + '</div><div class="feature-detail-stat-value">' + String(selectedFeature.hookCount) + '</div></div>',
        '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_active_tools')) + '</div><div class="feature-detail-stat-value">' + String(selectedFeature.enabledToolCount) + '/' + String(selectedFeature.toolCount) + '</div></div>',
        '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_status_label')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(getFeatureStatusLabel(getFeatureStatus(selectedFeature))) + '</div></div>',
        '</div>',
        '<div class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('panel_feature_details')) + '</div>',
        '<div class="feature-detail-subtitle">' + escapeHtml(shortenSourcePath(selectedFeature.source) || t('feature_source_missing')) + '</div>',
        '</div>',
        '<div class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('panel_loaded_tools')) + '</div>',
        selectedFeature.tools && selectedFeature.tools.length > 0
          ? '<div class="feature-tool-list">' + selectedFeature.tools.map(tool => [
              '<div class="feature-tool-card">',
              '<div class="feature-tool-top">',
              '<div class="feature-tool-name">' + escapeHtml(tool.name) + '</div>',
              '<div class="' + getStatusBadgeClass(tool.enabled ? 'enabled' : 'disabled') + '">' + escapeHtml(tool.enabled ? t('feature_tool_enabled') : t('feature_tool_disabled')) + '</div>',
              '</div>',
              '<div class="feature-tool-desc">' + escapeHtml(tool.description || '') + '</div>',
              '<div class="feature-tool-meta">',
              tool.renderCall ? '<span class="feature-tool-pill">' + escapeHtml(t('feature_tool_render')) + ': call/' + escapeHtml(tool.renderCall) + '</span>' : '',
              tool.renderResult ? '<span class="feature-tool-pill">' + escapeHtml(t('feature_tool_render')) + ': result/' + escapeHtml(tool.renderResult) + '</span>' : '',
              '</div>',
              '</div>',
            ].join('')).join('') + '</div>'
          : '<div class="feature-detail-subtitle">' + escapeHtml(t('panel_no_tools')) + '</div>',
        '</div>',
        '</div>',
        '</div>',
      ].join('') : '';

      return [
        '<div class="hooks-panel feature-detail-shell">',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_all_features')) + '</div><div class="hooks-section-meta">' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_registered')) + '</div></div>',
        '<div class="feature-grid">' + featureCards + '</div>',
        '</section>',
        detailOverlay,
        '</div>',
      ].join('');
    }

    function renderReverseHooksPanel() {
      const hookIcons = {
        AgentInitiate: 'A',
        AgentDestroy: 'D',
        CallStart: 'C',
        CallFinish: 'C',
        StepStart: 'S',
        StepFinish: 'R',
        ToolUse: 'T',
        ToolFinished: 'F',
      };

      const lifecycleCards = currentHookInspector.hooks
        .map(group => {
          const entriesHtml = group.entries.map((entry, index) => [
            '<div class="hook-step">',
            '<div class="hook-step-order">' + String(index + 1) + '</div>',
            '<div class="hook-step-card">',
            '<div class="hook-step-row">',
            '<div class="hook-step-feature">' + escapeHtml(entry.featureName) + '</div>',
            '<div class="hook-step-kind">' + escapeHtml(entry.kind) + '</div>',
            '</div>',
            '<div class="hook-step-method">' + escapeHtml(entry.methodName) + '()</div>',
            entry.source && entry.source.display ? '<div class="hook-step-location">' + escapeHtml(shortenSourcePath(entry.source.display)) + '</div>' : '',
            entry.description ? '<div class="hook-step-notes">' + escapeHtml(entry.description) + '</div>' : '',
            '</div>',
            '</div>',
          ].join('')).join('');

          return [
            '<section class="hook-lifecycle-card">',
            '<div class="hook-lifecycle-head">',
          '<div class="hook-lifecycle-name">',
          '<span class="hook-lifecycle-icon">' + escapeHtml(hookIcons[group.lifecycle] || 'H') + '</span>',
          '<div>',
          '<div>' + escapeHtml(group.lifecycle) + '</div>',
          '<div class="hook-lifecycle-type">' + escapeHtml(group.kind) + ' ' + escapeHtml(t('hook_kind')) + '</div>',
          '</div>',
          '</div>',
            '<div style="display:flex;align-items:center;gap:12px;">',
            '<div class="hooks-section-meta">' + String(group.entries.length) + ' ' + escapeHtml(t('panel_attached')) + '</div>',
            '</div>',
            '</div>',
            '<div class="hook-call-chain">',
            entriesHtml || '<div class="hooks-section-meta">' + escapeHtml(t('panel_no_handlers')) + '</div>',
            '</div>',
            '</section>',
          ].join('');
        })
        .join('');

      if (currentHookInspector.hooks.length === 0) {
        return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_hook_data')) + '</div><div>' + escapeHtml(t('panel_no_hook_data_desc')) + '</div></div></div>';
      }

      return [
        '<div class="hooks-panel">',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_reverse_hooks')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_all_lifecycle_slots')) + '</div></div>',
        '<div class="hook-lifecycle-list">' + lifecycleCards + '</div>',
        '</section>',
        '</div>',
      ].join('');
    }

    const featurePanels = {
      workspace: {
        title: () => t('panel_structure'),
        render: () => renderStructurePanel(),
      },
      monitor: {
        title: () => t('panel_monitor'),
        render: () => renderMonitorPanel(),
      },
      hooks: {
        title: () => t('panel_features'),
        render: () => renderFeaturesPanel(),
      },
      inspector: {
        title: () => t('panel_reverse_hooks'),
        render: () => renderReverseHooksPanel(),
      },
      logs: {
        title: () => t('panel_logs'),
        render: () => renderLogsPanel(),
      },
      mcp: {
        title: () => t('panel_mcp'),
        render: () => renderMcpPanel(),
      },
    };

    // Sidebar Toggle
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
    });

    const renderer = new marked.Renderer();
    renderer.codespan = function(code) {
      const text = typeof code === 'string'
        ? code
        : (code && typeof code === 'object' && 'text' in code
          ? code.text
          : String(code ?? ''));
      return '<code class="inline-code-accent">' + escapeHtml(text) + '</code>';
    };

    marked.setOptions({
      renderer,
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
      breaks: true
    });

    function escapeHtml(text) {
      const str = String(text);
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return str.replace(/[&<>"']/g, m => map[m]);
    }

    // 默认 fallback 模板（当动态加载失败时使用）
    const RENDER_TEMPLATES = {
      'json': {
        call: (args) => \`<pre style="margin:0; font-size:12px;">\${escapeHtml(JSON.stringify(args, null, 2))}</pre>\`,
        result: (data, success) => {
          if (!success) return formatError(data);
          const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
          return \`<pre class="bash-output">\${escapeHtml(displayData)}</pre>\`;
        }
      }
    };

    // 模板缓存
    const templateCache = new Map();

    function setConnectionStatus(connected) {
      statusBadge.textContent = connected ? t('status_connected') : t('status_disconnected');
      statusBadge.classList.toggle('disconnected', !connected);
    }

    function renderThemeToggle() {
      const isLight = currentTheme === 'light';
      themeToggle.title = isLight ? t('theme_toggle_dark') : t('theme_toggle_light');
      themeToggle.innerHTML = isLight
        ? '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56"></path></svg>'
        : '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path></svg>';
    }

    function applyLanguage() {
      localStorage.setItem('agentdev-language', currentLanguage);
      document.title = t('page_title');

      const sidebarToggleEl = document.getElementById('sidebar-toggle');
      const panelResizerEl = document.getElementById('feature-panel-resizer');
      const notificationCharLabel = document.querySelector('.notification-char-count')?.nextElementSibling;
      const workspaceButton = document.getElementById('rail-workspace');
      const monitorButton = document.getElementById('rail-monitor');
      const hooksButton = document.getElementById('rail-hooks');
      const inspectorButton = document.getElementById('rail-inspector');
      const logsButton = document.getElementById('rail-logs');
      const mcpButton = document.getElementById('rail-mcp');

      if (sidebarToggleEl) sidebarToggleEl.title = t('sidebar_toggle');
      if (panelResizerEl) panelResizerEl.title = t('resize_panel');
      if (notificationCharLabel) notificationCharLabel.textContent = t('chars');
      if (workspaceButton) workspaceButton.title = t('structure_tooltip');
      if (monitorButton) monitorButton.title = t('monitor_tooltip');
      if (hooksButton) hooksButton.title = t('features_tooltip');
      if (inspectorButton) inspectorButton.title = t('reverse_hooks_tooltip');
      if (logsButton) logsButton.title = t('logs_tooltip');
      if (mcpButton) mcpButton.title = t('mcp_tooltip');

      languageToggle.title = t('language_toggle');
      languageToggle.textContent = t('language_toggle_short');
      deleteAgentAction.textContent = t('delete_agent');

      renderThemeToggle();
      renderAgentList();
      renderFeaturePanel();

      if (!currentAgentId) {
        currentAgentTitle.textContent = t('page_title');
        statusBadge.textContent = t('status_no_agent');
      }

      if (currentMessages.length === 0) {
        container.innerHTML = getEmptyStateHtml();
        updateFollowLatestButton();
      } else {
        render(currentMessages);
      }
    }

    function applyTheme(theme) {
      currentTheme = theme === 'light' ? 'light' : 'dark';
      document.body.dataset.theme = currentTheme;
      localStorage.setItem('agentdev-theme', currentTheme);
      renderThemeToggle();
    }

    function renderFeaturePanel() {
      const activeElement = document.activeElement;
      const preserveLogSearchFocus = activeFeaturePanel === 'logs' && activeElement && activeElement.classList && activeElement.classList.contains('log-input');
      const preservedSelectionStart = preserveLogSearchFocus && typeof activeElement.selectionStart === 'number'
        ? activeElement.selectionStart
        : null;
      const preservedSelectionEnd = preserveLogSearchFocus && typeof activeElement.selectionEnd === 'number'
        ? activeElement.selectionEnd
        : null;

      if (!activeFeaturePanel || !featurePanels[activeFeaturePanel]) {
        featurePanel.classList.remove('open');
        featurePanelTitle.textContent = t('panel_structure');
        featurePanelBody.innerHTML = getFeaturePanelEmptyHtml();
        railButtons.forEach(button => button.classList.remove('active'));
        return;
      }

      const panel = featurePanels[activeFeaturePanel];
      featurePanel.classList.add('open');
      featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
      featurePanelTitle.textContent = typeof panel.title === 'function' ? panel.title() : panel.title;
      featurePanelBody.innerHTML = panel.render();
      railButtons.forEach(button => {
        button.classList.toggle('active', button.dataset.panel === activeFeaturePanel);
      });

      if (preserveLogSearchFocus) {
        const nextSearchInput = featurePanelBody.querySelector('.log-input');
        if (nextSearchInput) {
          nextSearchInput.focus();
          if (preservedSelectionStart !== null && preservedSelectionEnd !== null && typeof nextSearchInput.setSelectionRange === 'function') {
            nextSearchInput.setSelectionRange(preservedSelectionStart, preservedSelectionEnd);
          }
        }
      }
    }

    function toggleFeaturePanel(panelId) {
      activeFeaturePanel = activeFeaturePanel === panelId ? null : panelId;
      renderFeaturePanel();
    }

    window.setLogPanelScope = async (scope) => {
      logPanelScope = scope === 'all' ? 'all' : 'current';
      await loadLogs(true);
      renderFeaturePanel();
    };

    window.updateLogFilter = (key, value) => {
      logFilters[key] = value;
      renderFeaturePanel();
    };

    function closeAgentContextMenu() {
      agentContextMenu.classList.remove('open');
      contextMenuAgentId = null;
    }

    function openAgentContextMenu(agentId, x, y, canDelete) {
      contextMenuAgentId = canDelete ? agentId : null;
      deleteAgentAction.disabled = !canDelete;

      const margin = 8;
      agentContextMenu.classList.add('open');
      agentContextMenu.style.left = '0px';
      agentContextMenu.style.top = '0px';

      const rect = agentContextMenu.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - margin;
      const maxTop = window.innerHeight - rect.height - margin;
      agentContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
      agentContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
    }

    railButtons.forEach(button => {
      button.addEventListener('click', () => {
        toggleFeaturePanel(button.dataset.panel);
        if (button.dataset.panel === 'logs' && activeFeaturePanel === 'logs') {
          loadLogs(true).catch((error) => console.error('Failed to load logs:', error));
        } else if (button.dataset.panel === 'mcp' && activeFeaturePanel === 'mcp') {
          loadMcpInfo(true).catch((error) => console.error('Failed to load MCP info:', error));
        }
      });
    });

    themeToggle.addEventListener('click', () => {
      applyTheme(currentTheme === 'light' ? 'dark' : 'light');
    });

    languageToggle.addEventListener('click', () => {
      currentLanguage = currentLanguage === 'zh' ? 'en' : 'zh';
      applyLanguage();
    });

    featurePanelResizer.addEventListener('mousedown', (event) => {
      if (!featurePanel.classList.contains('open')) return;

      event.preventDefault();

      const handleMouseMove = (moveEvent) => {
        const nextWidth = window.innerWidth - moveEvent.clientX - 56;
        featurePanelWidth = Math.max(240, Math.min(640, nextWidth));
        featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    });


    function formatError(data) {
       const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
       return \`<div class="tool-error">
         <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
         <span>\${escapeHtml(text)}</span>
       </div>\`;
    }

    function interpolateTemplate(template, data) {
      return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const value = data[key];
        return value !== undefined ? String(value) : \`{{\${key}}}\`;
      });
    }

    function applyTemplate(template, data, success = true, args = {}) {
      if (typeof template === 'function') {
        return template(data, success, args);
      }
      // 处理内联模板对象 { call: ..., result: ... }
      if (typeof template === 'object' && template !== null) {
        const fn = template.result || template.call;
        if (typeof fn === 'function') {
          return fn(data, success, args);
        }
        if (typeof fn === 'string') {
          return interpolateTemplate(fn, data);
        }
      }
      return interpolateTemplate(template, data);
    }

    function parseToolResult(content) {
      try {
        const json = JSON.parse(content);
        if (json && typeof json === 'object' && 'success' in json && 'result' in json) {
          let data = json.result;
          // Try to unwrap double-encoded JSON strings
          if (typeof data === 'string') {
             try {
                if (data.trim().startsWith('"') || data.trim().startsWith('{') || data.trim().startsWith('[')) {
                   const parsed = JSON.parse(data);
                   data = parsed;
                }
             } catch (e) {
                // Not a JSON string, keep as is
             }
          }
          return { success: json.success, data: data };
        }
        return { success: true, data: content };
      } catch (e) {
        return { success: true, data: content };
      }
    }

    /**
     * 根据模板名解析文件路径
     * 优先级：Feature 模板 > 系统模板 > 兜底
     */
    const self = this;

    // 系统默认模板映射（兜底）
    const SYSTEM_TEMPLATE_MAP = {
      'agent-spawn': 'system/subagent',
      'agent-list': 'system/subagent',
      'agent-send': 'system/subagent',
      'agent-close': 'system/subagent',
      'wait': 'system/subagent',
      'file-read': 'system/fs',
      'file-write': 'system/fs',
      'file-list': 'system/fs',
      'skill': 'system/skill',
      'invoke_skill': 'system/skill',
      'command': 'system/shell',
      'bash': 'system/shell',
      'shell': 'system/shell',
      'web': 'system/web',
      'fetch': 'system/web',
      'math': 'system/math',
      'calculator': 'system/math',
      'read': 'opencode/read',
      'write': 'opencode/write',
      'edit': 'opencode/edit',
      'ls': 'opencode/ls',
      'glob': 'opencode/glob',
      'grep': 'opencode/grep',
    };

    function resolveTemplatePath(templateName) {
      // 1. 优先查找 Feature 模板（从后端注入的动态数据）
      if (FEATURE_TEMPLATE_MAP[templateName]) {
        return FEATURE_TEMPLATE_MAP[templateName];
      }

      // 2. 使用系统默认映射
      if (SYSTEM_TEMPLATE_MAP[templateName]) {
        return '/tools/' + SYSTEM_TEMPLATE_MAP[templateName] + '.render.js';
      }

      // 3. 兜底：按约定查找 opencode
      return '/tools/opencode/' + templateName + '.render.js';
    }

    /**
     * 异步加载模板
     * 支持从 Feature 目录或系统目录加载
     * 如果加载失败，回退到内置模板
     */
    async function loadTemplate(templateName) {
      if (templateCache.has(templateName)) {
        return templateCache.get(templateName);
      }

      try {
        const path = resolveTemplatePath(templateName);

        // 统一使用 URL 方式加载模板
        // Feature 模板: /features/shell/trash-delete.render.js
        // 系统模板: /tools/system/shell.render.js
        const module = await import(path);

        // 1. 优先使用 default export（Feature 模板）
        let template = module.default;
        if (template) {
          templateCache.set(templateName, template);
          return template;
        }

        // 2. 尝试从 TEMPLATES 对象获取（系统模板）
        if (module.TEMPLATES && module.TEMPLATES[templateName]) {
          template = module.TEMPLATES[templateName];
          templateCache.set(templateName, template);
          return template;
        }

        console.warn('[Viewer Worker] 模板 "' + templateName + '" 在文件中未找到');
        return null;
      } catch (e) {
        console.warn('[Viewer Worker] 加载模板失败: ' + templateName, e);
        return null;
      }
    }

    function getToolRenderTemplate(toolName) {
      const config = toolRenderConfigs[toolName];
      const callTemplateName = (config?.render?.call) || 'json';
      const resultTemplateName = (config?.render?.result) || 'json';

      const callIsInline = callTemplateName === '__inline__';
      const resultIsInline = resultTemplateName === '__inline__';

      let callTemplate, resultTemplate;

      if (callIsInline) {
        callTemplate = config?.render?.inlineCall;
      } else {
        // 优先从缓存读取
        const cached = templateCache.get(callTemplateName);
        callTemplate = cached?.call || RENDER_TEMPLATES['json'].call;
      }

      if (resultIsInline) {
        resultTemplate = config?.render?.inlineResult;
      } else {
        const cached = templateCache.get(resultTemplateName);
        resultTemplate = cached?.result || RENDER_TEMPLATES['json'].result;
      }

      return {
        call: callTemplate,
        result: resultTemplate,
        isInlineCall: callIsInline,
        isInlineResult: resultIsInline,
      };
    }

    function getToolDisplayName(toolName) {
      return TOOL_NAMES[toolName] || toolName;
    }

    async function loadAgents() {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        allAgents = data.agents || [];

        renderAgentList();
        renderFeaturePanel();

        if (data.currentAgentId && data.currentAgentId !== currentAgentId) {
          currentAgentId = data.currentAgentId;
          setFollowLatest(true);
          await loadAgentData(currentAgentId);
        }
      } catch (e) {
        console.error('Failed to load agents:', e);
      }
    }

    function renderAgentList() {
      agentList.innerHTML = allAgents.map(a => {
        const isActive = a.id === currentAgentId;
        const isConnected = a.connected !== false;
        // Agent ID 格式：agent-{序号}-{进程PID}
        const parts = a.id.split('-');
        const agentNum = parts[1] || '?';
        const pid = parts[2] || '';
        const displayId = pid ? '#'.concat(agentNum, ' (', pid, ')') : '#'.concat(agentNum);
        return \`
          <div
            class="agent-item \${isActive ? 'active' : ''} \${isConnected ? '' : 'disconnected'}"
            onclick="switchAgent('\${a.id}')"
            oncontextmenu="openAgentActions(event, '\${a.id}')"
          >
            <div class="agent-name">\${escapeHtml(a.name)}</div>
            <div class="agent-meta">
              <span class="agent-status">
                <span class="agent-status-dot"></span>
                <span>\${isConnected ? escapeHtml(t('status_connected')) : escapeHtml(t('status_disconnected'))}</span>
              </span>
              · \${displayId} · \${a.messageCount} \${escapeHtml(t('feature_messages'))}
            </div>
          </div>
        \`;
      }).join('');
      
      const activeAgent = allAgents.find(a => a.id === currentAgentId);
      if (activeAgent) {
        currentAgentTitle.textContent = activeAgent.name;
      } else {
        currentAgentTitle.textContent = t('page_title');
      }
    }

    window.switchAgent = async (newAgentId) => {
      if (newAgentId === currentAgentId) return;
      closeAgentContextMenu();
      try {
        const res = await fetch('/api/agents/current', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: newAgentId })
        });
        if (res.ok) {
          currentAgentId = newAgentId;
          setFollowLatest(true);
          await loadAgentData(newAgentId);
          renderAgentList(); // Update active state
        }
      } catch (e) {
        console.error('Failed to switch agent:', e);
      }
    };

    window.openAgentActions = (event, agentId) => {
      event.preventDefault();
      const agent = allAgents.find(item => item.id === agentId);
      if (!agent) return;
      openAgentContextMenu(agentId, event.clientX, event.clientY, agent.connected === false);
    };

    deleteAgentAction.addEventListener('click', async () => {
      if (!contextMenuAgentId) return;

      const agent = allAgents.find(item => item.id === contextMenuAgentId);
      if (!agent || agent.connected !== false) {
        closeAgentContextMenu();
        return;
      }

      const confirmed = window.confirm(t('delete_confirm'));
      if (!confirmed) {
        closeAgentContextMenu();
        return;
      }

      try {
        const res = await fetch(\`/api/agents/\${contextMenuAgentId}\`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || t('delete_failed_generic'));
        }

        closeAgentContextMenu();
        await loadAgents();

        if (data.currentAgentId && data.currentAgentId !== currentAgentId) {
          currentAgentId = data.currentAgentId;
          await loadAgentData(currentAgentId);
        } else if (!data.currentAgentId) {
          currentAgentId = null;
          currentMessages = [];
          setCurrentLogs([]);
          setCurrentHookInspector({ lifecycleOrder: [], features: [], hooks: [] });
          setCurrentOverviewSnapshot(getEmptyOverviewSnapshot());
          container.innerHTML = getEmptyStateHtml();
          setFollowLatest(true);
          currentAgentTitle.textContent = t('page_title');
        }
      } catch (e) {
        closeAgentContextMenu();
        window.alert(t('delete_failed') + (e && e.message ? e.message : e));
      }
    });

    document.addEventListener('click', (event) => {
      if (!agentContextMenu.contains(event.target)) {
        closeAgentContextMenu();
      }
    });

    window.addEventListener('resize', () => {
      closeAgentContextMenu();
      featurePanelWidth = Math.max(240, Math.min(640, featurePanelWidth));
      if (featurePanel.classList.contains('open')) {
        featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
      }
    });
    window.addEventListener('scroll', closeAgentContextMenu, true);
    container.addEventListener('wheel', markManualScrollIntent, { passive: true });
    container.addEventListener('touchstart', markManualScrollIntent, { passive: true });
    container.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'PageUp', 'Home', ' '].includes(event.key)) {
        markManualScrollIntent();
      }
    });
    container.addEventListener('scroll', () => {
      if (suppressFollowScrollEvent || !followLatestEnabled) {
        return;
      }
      if (!isNearBottom() && hasRecentManualScrollIntent()) {
        setFollowLatest(false);
      }
    });
    followLatestButton.addEventListener('click', () => {
      setFollowLatest(true, { scroll: true, behavior: 'smooth' });
    });

    async function loadLogs(forceRender = false) {
      try {
        const params = new URLSearchParams({
          scope: logPanelScope,
        });
        if (currentAgentId) {
          params.set('agentId', currentAgentId);
        }

        const res = await fetch('/api/logs?' + params.toString());
        if (!res.ok) {
          throw new Error('Failed to fetch logs');
        }
        const data = await res.json();
        const nextLogs = data.logs || [];
        const nextSignature = JSON.stringify({
          count: nextLogs.length,
          last: nextLogs.length > 0 ? nextLogs[nextLogs.length - 1].id : null,
        });

        if (nextSignature !== currentLogsSignature) {
          setCurrentLogs(nextLogs);
          if (activeFeaturePanel === 'logs') {
            renderFeaturePanel();
          }
        } else if (forceRender && activeFeaturePanel === 'logs') {
          renderFeaturePanel();
        }
      } catch (e) {
        if (forceRender && activeFeaturePanel === 'logs') {
          setCurrentLogs([]);
          renderFeaturePanel();
        }
      }
    }

    async function loadMcpInfo(forceRender = false) {
      try {
        const res = await fetch('/api/mcp-info');
        if (!res.ok) {
          throw new Error('Failed to fetch MCP info');
        }
        const data = await res.json();
        setCurrentMcpInfo(data);
        if (forceRender && activeFeaturePanel === 'mcp') {
          renderFeaturePanel();
        }
      } catch (e) {
        console.error('Failed to load MCP info:', e);
        if (forceRender && activeFeaturePanel === 'mcp') {
          renderFeaturePanel();
        }
      }
    }

    async function loadAgentData(agentId) {
      try {
        const [msgsRes, toolsRes, hooksRes, overviewRes] = await Promise.all([
          fetch(\`/api/agents/\${agentId}/messages\`),
          fetch(\`/api/agents/\${agentId}/tools\`),
          fetch(\`/api/agents/\${agentId}/hooks\`),
          fetch(\`/api/agents/\${agentId}/overview\`)
        ]);

        const msgsData = await msgsRes.json();
        const tools = await toolsRes.json();
        setCurrentHookInspector(await hooksRes.json());
        setCurrentOverviewSnapshot(await overviewRes.json());

        currentMessages = msgsData.messages || [];
        toolRenderConfigs = {};
        TOOL_NAMES = {};

        const DEFAULT_DISPLAY_NAMES = {
          // 系统工具
          run_shell_command: 'Bash',
          read_file: 'Read File',
          write_file: 'Write File',
          list_directory: 'List',
          web_fetch: 'Web',
          calculator: 'Calc',
          invoke_skill: 'Invoke Skill',
          spawn_agent: 'Spawn Agent',
          list_agents: 'List Agents',
          send_to_agent: 'Send to Agent',
          close_agent: 'Close Agent',
          // Opencode 工具
          read: 'Read',
          write: 'Write',
          edit: 'Edit',
          glob: 'Glob',
          grep: 'Grep',
          ls: 'LS',
        };

        for (const tool of tools) {
          toolRenderConfigs[tool.name] = tool;
          TOOL_NAMES[tool.name] = DEFAULT_DISPLAY_NAMES[tool.name] || tool.name;
        }

        // 预加载所有需要的模板
        const templatesToLoad = new Set();

        for (const tool of tools) {
          const renderConfig = tool.render;
          if (renderConfig) {
            if (typeof renderConfig === 'string') {
              templatesToLoad.add(renderConfig);
            } else if (typeof renderConfig === 'object') {
              if (renderConfig.call && renderConfig.call !== '__inline__') {
                templatesToLoad.add(renderConfig.call);
              }
              if (renderConfig.result && renderConfig.result !== '__inline__') {
                templatesToLoad.add(renderConfig.result);
              }
            }
          }
        }

        // 并行加载所有模板
        const loadPromises = Array.from(templatesToLoad).map(name => loadTemplate(name));
        await Promise.all(loadPromises);

        render(currentMessages);
        setFollowLatest(true, { scroll: true, behavior: 'auto' });
        if (activeFeaturePanel === 'logs') {
          await loadLogs(true);
        }
        renderFeaturePanel();
      } catch (e) {
        console.error('Failed to load agent data:', e);
      }
    }

    async function poll() {
      try {
        // 定期检查并重新加载 Feature 模板映射（如果为空）
        if (Object.keys(FEATURE_TEMPLATE_MAP).length === 0) {
          await reloadFeatureTemplateMap();
        }

        if (!currentAgentId) {
          await loadAgents();
          if (activeFeaturePanel === 'logs' && logPanelScope === 'all') {
            await loadLogs();
          }
          setTimeout(poll, 1000);
          return;
        }

        // 并行请求消息、通知和输入请求
        const [msgsRes, notifRes, connectionRes, inputRes, overviewRes] = await Promise.all([
          fetch(\`/api/agents/\${currentAgentId}/messages\`),
          fetch(\`/api/agents/\${currentAgentId}/notification\`),
          fetch(\`/api/agents/\${currentAgentId}/connection\`),
          fetch(\`/api/agents/\${currentAgentId}/input-requests\`),
          fetch(\`/api/agents/\${currentAgentId}/overview\`),
        ]);

        const connectionData = await connectionRes.json();
        setConnectionStatus(!!connectionData.connected);

        const data = await msgsRes.json();
        const messages = data.messages || [];

        // 处理通知状态
        const notifData = await notifRes.json();
        updateNotificationStatus(notifData);

        const nextOverview = normalizeOverviewSnapshot(await overviewRes.json());
        const nextOverviewSignature = getOverviewSignature(nextOverview);
        if (nextOverviewSignature !== currentOverviewSignature) {
          currentOverviewSnapshot = nextOverview;
          currentOverviewSignature = nextOverviewSignature;
          if (activeFeaturePanel === 'workspace') {
            renderFeaturePanel();
          }
        }

        // 处理输入请求（只在变化时重新渲染）
        const inputRequests = await inputRes.json();
        if (JSON.stringify(inputRequests) !== JSON.stringify(window.lastInputRequests || [])) {
          window.lastInputRequests = inputRequests;
          renderInputRequests(inputRequests);
          updateRollbackActionVisibility();
        }

        if (messages.length !== currentMessages.length || messages.length === 0) {
          if (messages.length > currentMessages.length) {
            // 有新消息：只追加新的
            const newMessages = messages.slice(currentMessages.length);
            currentMessages = messages;
            appendNewMessages(newMessages, currentMessages.length - newMessages.length);
          } else if (messages.length < currentMessages.length) {
            // 消息减少：完全重建（极少情况）
            currentMessages = messages;
            render(messages);
          } else {
            // 长度相同但内容可能是初始加载：完全重建
            currentMessages = messages;
            render(messages);
          }
        } else {
          const lastMsgChanged = messages.length > 0 &&
            JSON.stringify(messages[messages.length - 1]) !== JSON.stringify(currentMessages[currentMessages.length - 1]);
          if (lastMsgChanged) {
            // 最后一条消息变化：替换最后一条（避免滚动重置）
            currentMessages = messages;
            updateLastMessage(messages[messages.length - 1]);
          }
        }

        // Also refresh agent list occasionally to get new agents
        if (Math.random() < 0.1) {
           const agentsRes = await fetch('/api/agents');
           const agentsData = await agentsRes.json();
           if (JSON.stringify(agentsData.agents) !== JSON.stringify(allAgents)) {
             allAgents = agentsData.agents || [];
             renderAgentList();
             renderFeaturePanel();
           }
        }

        if (activeFeaturePanel) {
          if (activeFeaturePanel === 'logs') {
            await loadLogs();
          } else {
            const hooksRes = await fetch(\`/api/agents/\${currentAgentId}/hooks\`);
            const nextHookInspector = normalizeHookInspector(await hooksRes.json());
            const nextSignature = getHookInspectorSignature(nextHookInspector);
            if (nextSignature !== currentHookInspectorSignature) {
              currentHookInspector = nextHookInspector;
              currentHookInspectorSignature = nextSignature;
              renderFeaturePanel();
            } else if (activeFeaturePanel === 'inspector') {
              renderFeaturePanel();
            }
          }
        }

      } catch (e) {
        setConnectionStatus(false);
      }
      setTimeout(poll, 100);
    }

    // 通知状态更新
    function updateNotificationStatus(notifData) {
      const statusEl = document.getElementById('notification-status');
      const phaseEl = document.getElementById('notification-phase');
      const charCountEl = document.getElementById('notification-char-count');

      if (!notifData.state) {
        statusEl.style.display = 'none';
        return;
      }

      const { type, data } = notifData.state;

      if (type === 'llm.char_count') {
        statusEl.style.display = 'flex';
        statusEl.classList.add('active');

        const phaseNames = {
          'thinking': t('phase_thinking'),
          'content': t('phase_content'),
          'tool_calling': t('phase_tool_calling')
        };
        phaseEl.textContent = phaseNames[data.phase] || data.phase;
        charCountEl.textContent = data.charCount.toLocaleString();
      } else if (type === 'llm.complete') {
        statusEl.style.display = 'none';
        statusEl.classList.remove('active');
      } else {
        statusEl.style.display = 'none';
      }
    }

    // 渲染输入请求
    function renderInputRequests(requests) {
      const container = document.getElementById('user-input-container');
      if (!container) return;
      currentInputRequests = requests;

      // 清空现有内容
      container.innerHTML = '';

      for (const req of requests) {
        const card = document.createElement('div');
        card.className = 'user-input-card';
        const actionsHtml = Array.isArray(req.actions) && req.actions.length > 0
          ? '<div class="user-input-actions">' + req.actions.map(action =>
              '<button class="user-input-action ' + escapeHtml(action.variant || 'secondary') + '" onclick="submitInputAction(\\'' + req.requestId + '\\', \\'' + escapeHtml(action.id) + '\\')">' + escapeHtml(action.label) + '</button>'
            ).join('') + '</div>'
          : '';
        card.innerHTML = \`
          <textarea class="user-input-textarea" rows="1" id="input-\${req.requestId}"
            onkeydown="handleInputKey(event, '\${req.requestId}')"
            oninput="autoResize(this)"
            placeholder="\${escapeHtml(req.placeholder || t('input_placeholder'))}"></textarea>
          <div class="user-input-footer">
            \${actionsHtml}
          </div>
        \`;
        container.appendChild(card);
        
        // Auto-focus
        setTimeout(() => {
          const el = document.getElementById(\`input-\${req.requestId}\`);
          if(el) {
             if (typeof req.initialValue === 'string' && req.initialValue.length > 0) {
               el.value = req.initialValue;
             }
             el.focus();
             const end = el.value.length;
             if (typeof el.setSelectionRange === 'function') {
               el.setSelectionRange(end, end);
             }
             autoResize(el);
          }
        }, 50);
      }
    }

    function updateRollbackActionVisibility() {
      const allowRollback = !!getPrimaryInputRequest();
      document.querySelectorAll('.message-row.user .message-action').forEach((button) => {
        button.style.display = allowRollback ? '' : 'none';
      });
    }

    function autoResize(textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }

    function handleInputKey(event, requestId) {
      if (event.key === 'Enter') {
        if (event.ctrlKey || event.shiftKey) {
          // Ctrl+Enter or Shift+Enter for new line
          // default behavior is new line, but we might want to ensure it works
          return; 
        } else {
          // Enter for submit
          event.preventDefault();
          submitInput(requestId);
        }
      }
    }

    // 提交输入
    async function submitInput(requestId) {
      const textarea = document.getElementById(\`input-\${requestId}\`);
      const input = textarea ? textarea.value : '';

      try {
        const res = await fetch(\`/api/agents/\${currentAgentId}/input\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            input,
            response: {
              kind: 'text',
              text: input,
            },
          })
        });
        if (res.ok) {
          setFollowLatest(true, { scroll: true, behavior: 'smooth' });
          // 刷新输入请求列表
          poll();
        }
      } catch (e) {
        console.error('提交输入失败:', e);
      }
    }

    function getPrimaryInputRequest() {
      return Array.isArray(currentInputRequests) && currentInputRequests.length > 0
        ? currentInputRequests[0]
        : null;
    }

    function canRollbackMessage(msg) {
      return !!getPrimaryInputRequest() && !!msg && msg.role === 'user';
    }

    async function submitInputAction(requestId, actionId, payload = {}) {
      try {
        const res = await fetch(\`/api/agents/\${currentAgentId}/input\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            input: '',
            response: {
              kind: 'action',
              actionId,
              payload,
            },
          }),
        });
        if (res.ok) {
          poll();
        }
      } catch (e) {
        console.error('提交动作失败:', e);
      }
    }

    window.requestRollbackEdit = async function(messageIndex) {
      const request = getPrimaryInputRequest();
      if (!request) {
        console.warn('No pending input request available for rollback action');
        return;
      }

      const msg = currentMessages[messageIndex];
      if (!msg || msg.role !== 'user') {
        return;
      }

      const fallbackCallIndex = currentMessages
        .slice(0, messageIndex + 1)
        .filter(entry => entry.role === 'user')
        .length - 1;
      const callIndex = typeof msg.turn === 'number' ? msg.turn : fallbackCallIndex;

      await submitInputAction(request.requestId, 'rollback_to_call', {
        callIndex,
        draftInput: msg.content,
      });
    };

    // 生成单条消息的 HTML
    function renderMessage(msg, index) {
      const role = msg.role;
      const msgId = \`msg-\${index}\`;
      let contentHtml = '';
      let metaHtml = \`<div class="role-badge">\${role}</div>\`;
      if (canRollbackMessage(msg)) {
        metaHtml += \`<button class="message-action" onclick="requestRollbackEdit(\${index})">编辑此轮</button>\`;
      }

      if (role === 'user' || role === 'system') {
        let style = '';
        let rowClass = role;
        if (role === 'system') {
           const isLong = msg.content.includes('\\n') || msg.content.length > 60;
           if (isLong) {
             style = 'text-align: left !important;';
             rowClass += ' long-content';
           }
           contentHtml = \`<div class="message-content markdown-body" id="\${msgId}" style="\${style}">\${marked.parse(msg.content)}</div>\`;
        } else {
          contentHtml = \`<div class="message-content markdown-body" id="\${msgId}">\${marked.parse(msg.content)}</div>\`;
        }

        if (role === 'system') {
           return \`
            <div class="message-row \${rowClass}">
              <div class="message-meta">
                \${metaHtml}
              </div>
              \${contentHtml}
            </div>
          \`;
        }
        return \`
          <div class="message-row \${role}">
            <div class="message-meta">
              \${metaHtml}
            </div>
            \${contentHtml}
          </div>
        \`;
      } else if (role === 'assistant') {
        let innerContent = '';

        if (msg.reasoning) {
          innerContent += \`
            <div class="reasoning-block" id="reasoning-\${msgId}">
                <div class="reasoning-header" onclick="toggleReasoning('reasoning-\${msgId}')">
                  <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
                <span>\${escapeHtml(t('thinking_process'))}</span>
              </div>
              <div class="reasoning-content markdown-body">
                \${marked.parse(msg.reasoning)}
              </div>
            </div>
          \`;
        }

        // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
        const agentCompletePattern = /^[\\s\\S]*\\[子代理\\s+(\\S+)\\s+执行完成\\]:[\\s\\S]*$/;
        const agentCompleteMatch = msg.content.match(agentCompletePattern);
        if (agentCompleteMatch) {
          const agentName = agentCompleteMatch[1];
          // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
          const subAgent = allAgents.find(a => a.name === agentName);
          const subAgentId = subAgent ? subAgent.id : null;
          const clickAttr = subAgentId ? \`onclick="switchAgent('\${subAgentId}')"\` : '';
          const linkHtml = subAgentId
            ? \`<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" \${clickAttr}>\${escapeHtml(t('subagent_view_messages'))}</div>\`
            : '';

          innerContent += \`
              <div class="tool-call-container">
                <div class="tool-header">
                  <span class="tool-header-name">\${escapeHtml(t('subagent_done'))}</span>
                </div>
                <div class="tool-content">
                  <div class="bash-command">【\${escapeHtml(agentName)}】\${escapeHtml(t('subagent_done'))}</div>
                  \${linkHtml}
                </div>
              </div>
          \`;
        } else {
          innerContent += \`<div class="markdown-body">\${marked.parse(msg.content)}</div>\`;
        }

        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const toolsHtml = msg.toolCalls.map(call => {
            const displayName = getToolDisplayName(call.name);
            const template = getToolRenderTemplate(call.name);
            let innerHtml;

            if (template.call) {
              innerHtml = applyTemplate(template.call, call.arguments);
            } else {
              innerHtml = \`<pre style="margin:0; font-size:12px;">\${JSON.stringify(call.arguments, null, 2)}</pre>\`;
            }

            return \`
              <div class="tool-call-container">
                <div class="tool-header">
                  <span class="tool-header-name">\${displayName}</span>
                </div>
                <div class="tool-content">\${innerHtml}</div>
              </div>
            \`;
          }).join('');
          innerContent += toolsHtml;
        }

        contentHtml = \`<div class="message-content" id="\${msgId}">\${innerContent}</div>\`;

      } else if (role === 'tool') {
        const toolCallId = msg.toolCallId;
        let toolName = null;
        let toolArgs = {};

        // 查找对应的工具调用（需要传入完整消息列表）
        return '';  // 这个需要在完整上下文中处理，暂时返回空
      }

      return \`
        <div class="message-row \${role}">
          <div class="message-meta">
            \${metaHtml}
          </div>
          \${contentHtml}
        </div>
      \`;
    }

    // 追加新消息（保持现有 DOM 状态）
    function appendNewMessages(newMessages, startIndex) {
      // 移除空状态
      const emptyState = container.querySelector('.empty-state');
      if (emptyState) emptyState.remove();

      // 获取当前消息数量
      const currentCount = container.querySelectorAll('.message-row').length;

      newMessages.forEach((msg, i) => {
        const index = startIndex + i;
        const msgId = \`msg-\${index}\`;
        let html = '';

        if (msg.role === 'user' || msg.role === 'system' || msg.role === 'assistant') {
          html = renderMessage(msg, index);
        } else if (msg.role === 'tool') {
          // tool 需要特殊处理，查找对应的 toolCall
          let toolName = null;
          let toolArgs = {};
          const messages = currentMessages;
          const toolCallId = msg.toolCallId;

          for (const m of messages) {
            if (m.toolCalls) {
              const found = m.toolCalls.find(c => c.id === toolCallId);
              if (found) {
                toolName = found.name;
                toolArgs = found.arguments;
                break;
              }
            }
          }

          const { success, data } = parseToolResult(msg.content);
          const displayName = getToolDisplayName(toolName);
          const template = getToolRenderTemplate(toolName);

          let bodyHtml;
          if (template.result) {
             bodyHtml = applyTemplate(template.result, data, success, toolArgs);
          } else {
             const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
             bodyHtml = \`<pre class="bash-output">\${displayData}</pre>\`;
          }

          html = \`
            <div class="message-row \${msg.role}">
              <div class="message-meta">
                <div class="role-badge">\${msg.role}</div>
              </div>
              <div class="message-content" id="\${msgId}" style="padding:0; overflow:hidden;">
                <div class="tool-result-header">
                  <span class="status-dot \${success ? 'success' : 'error'}"></span>
                  <span>\${displayName}</span>
                </div>
                <div class="tool-result-body">\${bodyHtml}</div>
              </div>
            </div>
          \`;
        }

        // 追加到容器
        container.insertAdjacentHTML('beforeend', html);
      });

      // 对新消息应用折叠逻辑
      applyCollapseLogic(container, startIndex);
      updateFollowLatestButton();
      if (followLatestEnabled) {
        scheduleScrollToLatest('smooth');
      }
    }

    // 更新最后一条消息
    function updateLastMessage(msg) {
      const lastIndex = currentMessages.length - 1;
      const lastRow = container.querySelectorAll('.message-row')[lastIndex];
      if (!lastRow) {
        render(currentMessages);
        return;
      }

      const msgId = \`msg-\${lastIndex}\`;

      if (msg.role === 'tool') {
        // tool 消息更新：重建 tool-result-body
        const toolCallId = msg.toolCallId;
        let toolName = null;
        let toolArgs = {};

        for (const m of currentMessages) {
          if (m.toolCalls) {
            const found = m.toolCalls.find(c => c.id === toolCallId);
            if (found) {
              toolName = found.name;
              toolArgs = found.arguments;
              break;
            }
          }
        }

        const { success, data } = parseToolResult(msg.content);
        const displayName = getToolDisplayName(toolName);
        const template = getToolRenderTemplate(toolName);

        let bodyHtml;
        if (template.result) {
           bodyHtml = applyTemplate(template.result, data, success, toolArgs);
        } else {
           const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
           bodyHtml = \`<pre class="bash-output">\${displayData}</pre>\`;
        }

        const toolResultBody = lastRow.querySelector('.tool-result-body');
        if (toolResultBody) {
          toolResultBody.innerHTML = bodyHtml;
        }
      }

      updateFollowLatestButton();
      if (followLatestEnabled) {
        scheduleScrollToLatest('smooth');
      }
    }

    // 应用折叠逻辑（只处理指定索引后的消息）
    function applyCollapseLogic(containerElement, startIndex = 0) {
      const rows = containerElement.querySelectorAll('.message-row');
      rows.forEach((row, idx) => {
        if (idx < startIndex) return;  // 跳过旧消息

        const el = row.querySelector('.message-content');
        if (!el) return;

        const isCollapsible = el.scrollHeight > 160;
        const isSystem = row.classList.contains('system');
        const toolName = row.querySelector('.tool-result-header span:last-child')?.textContent || '';
        const isReadOrEdit = toolName === 'Read' || toolName === 'Edit';
        const shouldCollapse = isCollapsible && (isSystem || isReadOrEdit);

        if (isCollapsible) {
           if (shouldCollapse) {
             el.classList.add('collapsed');
             const meta = row.querySelector('.message-meta .collapse-toggle svg');
             if (meta) meta.style.transform = 'rotate(-90deg)';
           } else {
             el.classList.remove('collapsed');
             const meta = row.querySelector('.message-meta .collapse-toggle svg');
             if (meta) meta.style.transform = 'rotate(0deg)';
           }

           let btnBar = row.querySelector('.expand-toggle-bar');
           if (!btnBar) {
             btnBar = document.createElement('div');
             btnBar.className = 'expand-toggle-bar';
             row.appendChild(btnBar);
           }

           const isCollapsed = el.classList.contains('collapsed');
           btnBar.innerHTML = '<button class="expand-toggle-btn" onclick="toggleMessage(&quot;' + el.id + '&quot;)">' + getToggleButtonLabel(isCollapsed) + '</button>';

        } else {
           const toggle = row.querySelector('.collapse-toggle');
           if (toggle) toggle.style.display = 'none';
        }
      });
    }

    function render(messages) {
      if (messages.length === 0) {
        container.innerHTML = getEmptyStateHtml();
        updateFollowLatestButton();
        return;
      }

      const html = messages.map((msg, index) => {
        const role = msg.role;
        const msgId = \`msg-\${index}\`;
        let contentHtml = '';
        let metaHtml = \`<div class="role-badge">\${role}</div>\`;
        if (canRollbackMessage(msg)) {
          metaHtml += \`<button class="message-action" onclick="requestRollbackEdit(\${index})">编辑此轮</button>\`;
        }

        if (role === 'user' || role === 'system') {
          let style = '';
          let rowClass = role;
          if (role === 'system') {
             const isLong = msg.content.includes('\\n') || msg.content.length > 60;
             if (isLong) {
               style = 'text-align: left !important;';
               rowClass += ' long-content';
             }
             contentHtml = \`<div class="message-content markdown-body" id="\${msgId}" style="\${style}">\${marked.parse(msg.content)}</div>\`;
          } else {
            contentHtml = \`<div class="message-content markdown-body" id="\${msgId}">\${marked.parse(msg.content)}</div>\`;
          }
          
          if (role === 'system') {
             return \`
              <div class="message-row \${rowClass}">
                <div class="message-meta">
                  \${metaHtml}
                </div>
                \${contentHtml}
              </div>
            \`;
          }
        } else if (role === 'assistant') {
          let innerContent = '';

          if (msg.reasoning) {
            innerContent += \`
              <div class="reasoning-block" id="reasoning-\${msgId}">
                <div class="reasoning-header" onclick="toggleReasoning('reasoning-\${msgId}')">
                  <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
                  <span>\${escapeHtml(t('thinking_process'))}</span>
                </div>
                <div class="reasoning-content markdown-body">
                  \${marked.parse(msg.reasoning)}
                </div>
              </div>
            \`;
          }

          // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
          const agentCompletePattern = /^[\\s\\S]*\\[子代理\\s+(\\S+)\\s+执行完成\\]:[\\s\\S]*$/;
          const agentCompleteMatch = msg.content.match(agentCompletePattern);
          if (agentCompleteMatch) {
            const agentName = agentCompleteMatch[1];
            // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
            const subAgent = allAgents.find(a => a.name === agentName);
            const subAgentId = subAgent ? subAgent.id : null;
            const clickAttr = subAgentId ? \`onclick="switchAgent('\${subAgentId}')"\` : '';
            const linkHtml = subAgentId
              ? \`<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" \${clickAttr}>\${escapeHtml(t('subagent_view_messages'))}</div>\`
              : '';

            innerContent += \`
              <div class="tool-call-container">
                <div class="tool-header">
                  <span class="tool-header-name">\${escapeHtml(t('subagent'))}</span>
                </div>
                <div class="tool-content">
                  <div class="bash-command">\${escapeHtml(agentName)} \${escapeHtml(t('subagent_done'))}</div>
                  \${linkHtml}
                </div>
              </div>
            \`;
          } else {
            innerContent += \`<div class="markdown-body">\${marked.parse(msg.content)}</div>\`;
          }

          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const toolsHtml = msg.toolCalls.map(call => {
              const displayName = getToolDisplayName(call.name);
              const template = getToolRenderTemplate(call.name);
              let innerHtml;

              if (template.call) {
                innerHtml = applyTemplate(template.call, call.arguments);
              } else {
                innerHtml = \`<pre style="margin:0; font-size:12px;">\${JSON.stringify(call.arguments, null, 2)}</pre>\`;
              }

              return \`
                <div class="tool-call-container">
                  <div class="tool-header">
                    <span class="tool-header-name">\${displayName}</span>
                  </div>
                  <div class="tool-content">\${innerHtml}</div>
                </div>
              \`;
            }).join('');
            innerContent += toolsHtml;
          }

          contentHtml = \`<div class="message-content" id="\${msgId}">\${innerContent}</div>\`;

        } else if (role === 'tool') {
          const toolCallId = msg.toolCallId;
          let toolName = null;
          let toolArgs = {};
          
          for (const m of messages) {
            if (m.toolCalls) {
              const found = m.toolCalls.find(c => c.id === toolCallId);
              if (found) { 
                toolName = found.name;
                toolArgs = found.arguments;
                break; 
              }
            }
          }

          const { success, data } = parseToolResult(msg.content);
          const displayName = getToolDisplayName(toolName);
          const template = getToolRenderTemplate(toolName);
          
          let bodyHtml;
          if (template.result) {
             bodyHtml = applyTemplate(template.result, data, success, toolArgs);
          } else {
             const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
             bodyHtml = \`<pre class="bash-output">\${displayData}</pre>\`;
          }

          contentHtml = \`
            <div class="message-content" id="\${msgId}" style="padding:0; overflow:hidden;">
              <div class="tool-result-header">
                <span class="status-dot \${success ? 'success' : 'error'}"></span>
                <span>\${displayName}</span>
              </div>
              <div class="tool-result-body">\${bodyHtml}</div>
            </div>\`;
        }

        return \`
          <div class="message-row \${role}">
            <div class="message-meta">
              \${metaHtml}
            </div>
            \${contentHtml}
          </div>
        \`;
      }).join('');

      container.innerHTML = html;

      document.querySelectorAll('.message-row').forEach(row => {
        const el = row.querySelector('.message-content');
        if (!el) return;

        const isCollapsible = el.scrollHeight > 160;
        const isSystem = row.classList.contains('system');
        // 检查是否是 read 或 edit 工具
        const toolName = row.querySelector('.tool-result-header span:last-child')?.textContent || '';
        const isReadOrEdit = toolName === 'Read' || toolName === 'Edit';
        const shouldCollapse = isCollapsible && (isSystem || isReadOrEdit);

        if (isCollapsible) {
           if (shouldCollapse) {
             el.classList.add('collapsed');
             // Meta toggle rotation
             const meta = row.querySelector('.message-meta .collapse-toggle svg');
             if (meta) meta.style.transform = 'rotate(-90deg)';
           } else {
             el.classList.remove('collapsed');
             const meta = row.querySelector('.message-meta .collapse-toggle svg');
             if (meta) meta.style.transform = 'rotate(0deg)';
           }
           
           // Inject Toggle Button
           let btnBar = row.querySelector('.expand-toggle-bar');
           if (!btnBar) {
             btnBar = document.createElement('div');
             btnBar.className = 'expand-toggle-bar';
             row.appendChild(btnBar);
           }
           
           const isCollapsed = el.classList.contains('collapsed');
           btnBar.innerHTML = '<button class="expand-toggle-btn" onclick="toggleMessage(&quot;' + el.id + '&quot;)">' + getToggleButtonLabel(isCollapsed) + '</button>';
           
        } else {
           const toggle = row.querySelector('.collapse-toggle');
           if (toggle) toggle.style.display = 'none';
        }
      });

      updateRollbackActionVisibility();
      updateFollowLatestButton();
      if (followLatestEnabled) {
        scheduleScrollToLatest('auto');
      }
    }

    window.toggleMessage = function(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle('collapsed');
        const row = el.closest('.message-row');
        const isCollapsed = el.classList.contains('collapsed');

        // Update meta icon
        const meta = row.querySelector('.message-meta .collapse-toggle svg');
        if (meta) {
           meta.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'; // meta uses transform
           // Fix: meta.transform in previous code was wrong, it's meta.style.transform
        }
        
        // Update bottom button
        const btn = row.querySelector('.expand-toggle-btn');
        if (btn) {
          btn.innerHTML = getToggleButtonLabel(isCollapsed);
        }
      }
    };

    window.toggleReasoning = function(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle('expanded');
      }
    };

    // 初始化：先加载 Feature 模板映射，再启动轮询
    // 如果 Feature 模板映射为空（Agent 还未注册），在 loadAgents 后重新加载
    applyTheme(currentTheme);
    applyLanguage();

    loadFeatureTemplateMap().then((success) => {
      loadAgents().then(async () => {
        // 如果第一次加载 Feature 模板失败，重新尝试
        if (!success) {
          console.log('[Viewer] Retrying to load feature templates after agent loaded...');
          await reloadFeatureTemplateMap();
        }
        await loadMcpInfo(false);
        poll();
      });
    });
  </script>
</body>
</html>`;
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
      case 'set-current-agent':
        worker.handleSetCurrentAgent(msg);
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
