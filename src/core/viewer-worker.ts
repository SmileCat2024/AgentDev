
/**
 * Viewer Worker - 在独立进程中运行 HTTP 服务器
 * 支持多 Agent 调试，共享单端口
 * 支持通过 UDS（Unix Domain Socket）或 Windows Named Pipe 接收来自多进程的连接
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createServer as createNetServer, Server, Socket } from 'net';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { type Message, type Tool, AgentSession, DebugHubIPCMessage, ToolMetadata, getDefaultUDSPath } from './types.js';
import {
  RENDER_TEMPLATES,
  SYSTEM_RENDER_MAP,
  TOOL_DISPLAY_NAMES,
  getToolRenderConfig
} from './render.js';
import { TemplateRouter } from './template-router.js';

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

  // 模板路由器
  private templateRouter: TemplateRouter = new TemplateRouter();

  // 内存限制配置
  private readonly MAX_MESSAGES = 10000;
  private readonly MAX_BYTES = 50 * 1024 * 1024; // 50MB

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
    const url = req.url || '/';

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
    const url = req.url || '';

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
        const { requestId, input } = JSON.parse(body);

        const session = this.agentSessions.get(agentId);
        const pendingRequests = (session as any).pendingInputRequests as Map<string, any> | undefined;
        if (!session || !pendingRequests?.has(requestId)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Request not found or expired' }));
          return;
        }

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
                input,
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
                input,
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
    const { agentId, name, createdAt, projectRoot, featureTemplates } = msg;
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
      // 同步到模板路由器
      this.templateRouter.updateFeatureTemplates(featureTemplates);
    }

    // 首个 Agent 自动成为当前
    if (this.agentSessions.size === 1) {
      this.currentAgentId = agentId;
    }

    console.log(`[Viewer Worker] Agent 已注册: ${agentId} (${name})${clientId ? ` [client: ${clientId}]` : ''}`);
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

    if (notification.category === 'state') {
      // 状态类通知：覆盖当前状态
      session.currentState = notification;
    } else if (notification.category === 'event') {
      // 事件类通知：追加到事件列表
      session.events.push(notification);
      session.lastEventCount++;
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
      padding: 16px 18px 20px 20px;
    }

    .feature-panel-empty {
      display: flex;
      flex-direction: column;
      gap: 10px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .feature-panel-section {
      padding: 12px 14px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.02);
    }

    .feature-panel-section-title {
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
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
      display: none;
    }

    .user-input-submit {
      display: none;
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
      <button class="rail-button" id="rail-workspace" title="Workspace" data-panel="workspace">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="4" width="18" height="16" rx="2"></rect>
          <path d="M9 4v16"></path>
        </svg>
      </button>
      <button class="rail-button" id="rail-inspector" title="Inspector" data-panel="inspector">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="11" cy="11" r="6"></circle>
          <path d="m20 20-3.5-3.5"></path>
        </svg>
      </button>
      <div class="rail-spacer"></div>
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
    const railButtons = Array.from(document.querySelectorAll('.rail-button'));
    const themeToggle = document.getElementById('theme-toggle');

    let currentAgentId = null;
    let allAgents = [];
    let currentMessages = [];
    let toolRenderConfigs = {};
    let TOOL_NAMES = {};
    let contextMenuAgentId = null;
    let activeFeaturePanel = null;
    let featurePanelWidth = 320;
    let currentTheme = localStorage.getItem('agentdev-theme') || 'dark';

    const featurePanels = {
      workspace: {
        title: 'Workspace',
        render: () => \`
          <div class="feature-panel-empty">
            <div class="feature-panel-section">
              <div class="feature-panel-section-title">面板占位</div>
              <div>这里是右侧功能面板的基础容器，后续可以继续挂接更多调试工具、会话视图或辅助操作。</div>
            </div>
            <div class="feature-panel-section">
              <div class="feature-panel-section-title">当前状态</div>
              <div>左侧 Agent 列表、中央对话区、右侧功能区现在已经形成可扩展的三栏布局。</div>
            </div>
          </div>
        \`,
      },
      inspector: {
        title: 'Inspector',
        render: () => {
          const activeAgent = allAgents.find(agent => agent.id === currentAgentId);
          const connected = activeAgent ? (activeAgent.connected !== false ? 'Connected' : 'Disconnected') : 'No agent';
          return \`
            <div class="feature-panel-empty">
              <div class="feature-panel-section">
                <div class="feature-panel-section-title">Active Agent</div>
                <div>\${activeAgent ? escapeHtml(activeAgent.name) : 'None'}</div>
              </div>
              <div class="feature-panel-section">
                <div class="feature-panel-section-title">Connection</div>
                <div>\${connected}</div>
              </div>
              <div class="feature-panel-section">
                <div class="feature-panel-section-title">Messages</div>
                <div>\${currentMessages.length}</div>
              </div>
            </div>
          \`;
        },
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
      statusBadge.textContent = connected ? 'Connected' : 'Disconnected';
      statusBadge.classList.toggle('disconnected', !connected);
    }

    function renderThemeToggle() {
      const isLight = currentTheme === 'light';
      themeToggle.title = isLight ? '切换到深色模式' : '切换到浅色模式';
      themeToggle.innerHTML = isLight
        ? '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56"></path></svg>'
        : '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path></svg>';
    }

    function applyTheme(theme) {
      currentTheme = theme === 'light' ? 'light' : 'dark';
      document.body.dataset.theme = currentTheme;
      localStorage.setItem('agentdev-theme', currentTheme);
      renderThemeToggle();
    }

    function renderFeaturePanel() {
      if (!activeFeaturePanel || !featurePanels[activeFeaturePanel]) {
        featurePanel.classList.remove('open');
        featurePanelTitle.textContent = 'Workspace';
        featurePanelBody.innerHTML = '<div class="feature-panel-empty"><div>选择右侧功能按钮以展开面板。</div></div>';
        railButtons.forEach(button => button.classList.remove('active'));
        return;
      }

      featurePanel.classList.add('open');
      featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
      featurePanelTitle.textContent = featurePanels[activeFeaturePanel].title;
      featurePanelBody.innerHTML = featurePanels[activeFeaturePanel].render();
      railButtons.forEach(button => {
        button.classList.toggle('active', button.dataset.panel === activeFeaturePanel);
      });
    }

    function toggleFeaturePanel(panelId) {
      activeFeaturePanel = activeFeaturePanel === panelId ? null : panelId;
      renderFeaturePanel();
    }

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
      });
    });

    themeToggle.addEventListener('click', () => {
      applyTheme(currentTheme === 'light' ? 'dark' : 'light');
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
                <span>\${isConnected ? 'Connected' : 'Disconnected'}</span>
              </span>
              · \${displayId} · \${a.messageCount} msgs
            </div>
          </div>
        \`;
      }).join('');
      
      const activeAgent = allAgents.find(a => a.id === currentAgentId);
      if (activeAgent) {
        currentAgentTitle.textContent = activeAgent.name;
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

      const confirmed = window.confirm('删除这个已断开的 Agent？这只会从当前调试界面移除它的记录。');
      if (!confirmed) {
        closeAgentContextMenu();
        return;
      }

      try {
        const res = await fetch(\`/api/agents/\${contextMenuAgentId}\`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Delete failed');
        }

        closeAgentContextMenu();
        await loadAgents();

        if (data.currentAgentId && data.currentAgentId !== currentAgentId) {
          currentAgentId = data.currentAgentId;
          await loadAgentData(currentAgentId);
        } else if (!data.currentAgentId) {
          currentAgentId = null;
          currentMessages = [];
          container.innerHTML = '<div class="empty-state">Waiting for messages...</div>';
          currentAgentTitle.textContent = 'Agent Debugger';
        }
      } catch (e) {
        closeAgentContextMenu();
        window.alert('删除 Agent 失败: ' + (e && e.message ? e.message : e));
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

    async function loadAgentData(agentId) {
      try {
        const [msgsRes, toolsRes] = await Promise.all([
          fetch(\`/api/agents/\${agentId}/messages\`),
          fetch(\`/api/agents/\${agentId}/tools\`)
        ]);

        const msgsData = await msgsRes.json();
        const tools = await toolsRes.json();

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
          setTimeout(poll, 1000);
          return;
        }

        // 并行请求消息、通知和输入请求
        const [msgsRes, notifRes, connectionRes, inputRes] = await Promise.all([
          fetch(\`/api/agents/\${currentAgentId}/messages\`),
          fetch(\`/api/agents/\${currentAgentId}/notification\`),
          fetch(\`/api/agents/\${currentAgentId}/connection\`),
          fetch(\`/api/agents/\${currentAgentId}/input-requests\`),
        ]);

        const connectionData = await connectionRes.json();
        setConnectionStatus(!!connectionData.connected);

        const data = await msgsRes.json();
        const messages = data.messages || [];

        // 处理通知状态
        const notifData = await notifRes.json();
        updateNotificationStatus(notifData);

        // 处理输入请求（只在变化时重新渲染）
        const inputRequests = await inputRes.json();
        if (JSON.stringify(inputRequests) !== JSON.stringify(window.lastInputRequests || [])) {
          window.lastInputRequests = inputRequests;
          renderInputRequests(inputRequests);
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

        if (activeFeaturePanel === 'inspector') {
          renderFeaturePanel();
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
          'thinking': '思考中',
          'content': '生成内容',
          'tool_calling': '工具调用'
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

      // 清空现有内容
      container.innerHTML = '';

      for (const req of requests) {
        const card = document.createElement('div');
        card.className = 'user-input-card';
        // 极简设计：只有 Textarea
        card.innerHTML = \`
          <textarea class="user-input-textarea" rows="1" id="input-\${req.requestId}"
            onkeydown="handleInputKey(event, '\${req.requestId}')"
            oninput="autoResize(this)"
            placeholder="正在与Agent对话"></textarea>
        \`;
        container.appendChild(card);
        
        // Auto-focus
        setTimeout(() => {
          const el = document.getElementById(\`input-\${req.requestId}\`);
          if(el) {
             el.focus();
             autoResize(el);
          }
        }, 50);
      }
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
          body: JSON.stringify({ requestId, input })
        });
        if (res.ok) {
          // 刷新输入请求列表
          poll();
        }
      } catch (e) {
        console.error('提交输入失败:', e);
      }
    }

    // 生成单条消息的 HTML
    function renderMessage(msg, index) {
      const role = msg.role;
      const msgId = \`msg-\${index}\`;
      let contentHtml = '';
      let metaHtml = \`<div class="role-badge">\${role}</div>\`;

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
                <span>Thinking Process</span>
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
            ? \`<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" \${clickAttr}>查看消息 ></div>\`
            : '';

          innerContent += \`
            <div class="tool-call-container">
              <div class="tool-header">
                <span class="tool-header-name">已完成</span>
              </div>
              <div class="tool-content">
                <div class="bash-command">【\${escapeHtml(agentName)}】已完成</div>
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
           btnBar.innerHTML = \`
             <button class="expand-toggle-btn" onclick="toggleMessage('\${el.id}')">
               \${isCollapsed ?
                 '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> Expand' :
                 '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> Collapse'}
             </button>
           \`;

        } else {
           const toggle = row.querySelector('.collapse-toggle');
           if (toggle) toggle.style.display = 'none';
        }
      });
    }

    function render(messages) {
      if (messages.length === 0) {
        container.innerHTML = '<div class="empty-state">Waiting for messages...</div>';
        return;
      }

      const html = messages.map((msg, index) => {
        const role = msg.role;
        const msgId = \`msg-\${index}\`;
        let contentHtml = '';
        let metaHtml = \`<div class="role-badge">\${role}</div>\`;

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
                  <span>Thinking Process</span>
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
              ? \`<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" \${clickAttr}>查看消息 ></div>\`
              : '';

            innerContent += \`
              <div class="tool-call-container">
                <div class="tool-header">
                  <span class="tool-header-name">SubAgent</span>
                </div>
                <div class="tool-content">
                  <div class="bash-command">\${escapeHtml(agentName)}已完成</div>
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
           btnBar.innerHTML = \`
             <button class="expand-toggle-btn" onclick="toggleMessage('\${el.id}')">
               \${isCollapsed ? 
                 '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> Expand' : 
                 '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> Collapse'}
             </button>
           \`;
           
        } else {
           const toggle = row.querySelector('.collapse-toggle');
           if (toggle) toggle.style.display = 'none';
        }
      });
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
          btn.innerHTML = isCollapsed ? 
             '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> Expand' : 
             '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> Collapse';
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

    loadFeatureTemplateMap().then((success) => {
      loadAgents().then(async () => {
        // 如果第一次加载 Feature 模板失败，重新尝试
        if (!success) {
          console.log('[Viewer] Retrying to load feature templates after agent loaded...');
          await reloadFeatureTemplateMap();
        }
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
  const mainPath = process.argv[1].replace(/\\/g, '/');
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
