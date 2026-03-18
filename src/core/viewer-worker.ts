
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
import { generateViewerHtml } from './viewer-html.js';

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

    // 统一的 Feature 模板路由（新格式：/template/{packageName}/{templateName}.render.js）
    if (url.startsWith('/template/')) {
      this.handleUnifiedTemplate(req, res, url);
      return;
    }

    // Feature 工具渲染模板（旧格式，向后兼容）
    if (url.startsWith('/features/')) {
      this.handleFeatureTemplate(req, res, url);
      return;
    }

    // npm 包中的 Feature 模板（旧格式，向后兼容）
    if (url.startsWith('/npm/')) {
      this.handleNpmFeatureTemplate(req, res, url);
      return;
    }

    // 静态资源：chunk 文件和其他 JS/CSS 文件
    if (/^\/(chunk-|BasicAgent-|ExplorerAgent-|notification-|resolver-|types-|index\.js).*$/.test(url)) {
      this.handleStaticAsset(req, res, url);
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

    // 获取当前 Agent 的项目根目录
    const projectRoot = this.currentAgentId
      ? this.agentSessions.get(this.currentAgentId)?.projectRoot
      : undefined;

    // 将绝对路径转换为 HTTP URL
    const featureTemplateMapForFrontend: Record<string, string> = {};
    for (const [templateName, absolutePath] of Object.entries(this.featureTemplateMap)) {
      const normalizedPath = absolutePath.replace(/\\/g, '/');
      const url = this.templatePathToUrl(normalizedPath, projectRoot);
      if (url) {
        featureTemplateMapForFrontend[templateName] = url;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(featureTemplateMapForFrontend));
  }

  /**
   * 将模板文件路径转换为 HTTP URL
   * 支持多种来源：
   * 1. 独立 npm 包 node_modules/@scope/package/dist/templates/xxx.render.js
   * 2. npm 包 node_modules/agentdev/dist/features/xxx/templates/xxx.render.js
   * 3. npm workspace 符号链接（路径是真实物理路径，但需要转换为 node_modules 路径）
   * 4. 项目内 dist/features/xxx/templates/xxx.render.js
   * 5. 项目内 src/features/xxx/templates/xxx.render.ts
   * 6. 用户自定义路径
   */
  private templatePathToUrl(normalizedPath: string, projectRoot?: string): string | null {
    // 如果已经是 URL 格式，直接返回
    if (normalizedPath.startsWith('/template/') || 
        normalizedPath.startsWith('/features/') || 
        normalizedPath.startsWith('/npm/') ||
        normalizedPath.startsWith('/tools/')) {
      return normalizedPath;
    }

    // 规范化路径：统一使用 / 分隔符
    let normalizedForMatch = normalizedPath.replace(/\\/g, '/');
    
    // 处理 Windows 盘符路径
    // 格式可能是: /D:/code/... 或 D:/code/...
    const windowsDriveMatch = normalizedForMatch.match(/^(?:\/)?([A-Za-z]):\/(.+)$/);
    if (windowsDriveMatch) {
      normalizedForMatch = windowsDriveMatch[2]; // 只保留盘符后的路径部分
    }
    
    // 如果有项目根目录，提取相对于项目根目录的路径
    if (projectRoot) {
      const normalizedProjectRoot = projectRoot.replace(/\\/g, '/');
      // 尝试匹配项目根目录（可能包含盘符）
      const projectRootMatch = normalizedProjectRoot.match(/^(?:\/)?([A-Za-z]):\/(.+)$/);
      if (projectRootMatch) {
        const projectRootPath = projectRootMatch[2]; // 移除盘符后的项目根目录
        if (normalizedForMatch.startsWith(projectRootPath + '/')) {
          normalizedForMatch = normalizedForMatch.substring(projectRootPath.length + 1);
        }
      } else if (normalizedForMatch.startsWith(normalizedProjectRoot + '/')) {
        normalizedForMatch = normalizedForMatch.substring(normalizedProjectRoot.length + 1);
      }
    }

    // 模式 1: 独立 npm 包路径 node_modules/@scope/package/dist/templates/xxx.render.js
    // 例如: node_modules/@agentdev/shell-feature/dist/templates/bash.render.js
    let match = normalizedForMatch.match(/node_modules\/(@[^/]+\/[^/]+)\/dist\/templates\/(.+\.render\.js)$/);
    if (match) {
      const [, scopedPackageName, templateFile] = match;
      return `/npm/${scopedPackageName}/templates/${templateFile}`;
    }

    // 模式 1b: 独立 npm 包路径（无 scope）node_modules/package/dist/templates/xxx.render.js
    match = normalizedForMatch.match(/node_modules\/([^/@][^/]*)\/dist\/templates\/(.+\.render\.js)$/);
    if (match) {
      const [, packageName, templateFile] = match;
      return `/npm/${packageName}/templates/${templateFile}`;
    }

    // 模式 2: npm 包路径 node_modules/xxx/dist/features/xxx/templates/xxx.render.js
    match = normalizedForMatch.match(/node_modules\/([^/]+)\/dist\/features\/([^/]+)\/templates\/(.+\.render\.js)$/);
    if (match) {
      const [, packageName, featureName, templateFile] = match;
      return `/npm/${packageName}/features/${featureName}/${templateFile}`;
    }

    // 模式 3: npm workspace 符号链接（检查路径是否来自 node_modules 中的符号链接目标）
    // 例如：D:/code/AgentDev/dist/features/... 可能来自 D:/code/Project/node_modules/agentdev -> D:/code/AgentDev
    if (projectRoot) {
      const npmPackageUrl = this.resolveNpmWorkspacePackage(normalizedPath, projectRoot);
      if (npmPackageUrl) {
        return npmPackageUrl;
      }
    }

    // 模式 4: 项目内 dist 路径（支持 Windows 盘符前缀）
    match = normalizedForMatch.match(/dist\/features\/([^/]+)\/templates\/(.+\.render\.js)$/);
    if (match) {
      const [, featureName, templateFile] = match;
      return `/features/${featureName}/${templateFile}`;
    }

    // 模式 4b: packages 目录下的独立包路径 packages/xxx/dist/templates/xxx.render.js
    // 例如: packages/shell-feature/dist/templates/bash.render.js
    match = normalizedForMatch.match(/packages\/([^/]+)\/dist\/templates\/(.+\.render\.js)$/);
    if (match) {
      const [, packageName, templateFile] = match;
      // 将包名转换为 npm 包格式，假设是 @agentdev scope
      return `/npm/@agentdev/${packageName}/templates/${templateFile}`;
    }

    // 模式 5: 项目内 src 路径（支持 Windows 盘符前缀）
    match = normalizedForMatch.match(/src\/features\/([^/]+)\/templates\/(.+\.render\.(ts|js))$/);
    if (match) {
      const [, featureName, templateFile] = match;
      return `/features/${featureName}/${templateFile}`;
    }

    // 无法匹配的路径，记录警告
    console.warn(`[Viewer Worker] 无法解析模板路径: ${normalizedPath}`);
    return null;
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
    } catch (e) {
      // 忽略扫描错误
    }

    return null;
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
   * 
   * 支持从多个位置查找：
   * 1. 项目根目录 dist/tools/
   * 2. npm 包 node_modules/agentdev/dist/tools/
   */
  public handleStaticToolFile(req: IncomingMessage, res: ServerResponse, url: string): void {
    try {
      // 解析路径: /tools/system/shell.render.js
      const relativePath = url.substring('/tools/'.length);

      // 获取当前 Agent 的项目根目录
      const currentSession = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
      const projectRoot = currentSession?.projectRoot || process.cwd();

      // 计算可能的文件路径
      const searchPaths = [
        // 1. 项目根目录 dist/tools/
        join(projectRoot, 'dist/tools', relativePath),
        // 2. npm 包 node_modules/agentdev/dist/tools/
        join(projectRoot, 'node_modules/agentdev/dist/tools', relativePath),
      ];

      // 按顺序尝试每个路径
      this.tryReadFile(searchPaths, 0, res, url);
    } catch (err: any) {
      console.error('[Viewer Worker] 静态文件处理错误:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  /**
   * 尝试从多个路径读取文件
   */
  private tryReadFile(paths: string[], index: number, res: ServerResponse, originalUrl: string): void {
    if (index >= paths.length) {
      console.error(`[Viewer Worker] 模板未找到，尝试了所有路径: ${paths.join(', ')}`);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Template not found: ${originalUrl}`);
      return;
    }

    const currentPath = paths[index];
    
    import('fs').then((fs) => {
      fs.readFile(currentPath, 'utf-8', (err: Error | null, data: string) => {
        if (err) {
          // 当前路径失败，尝试下一个
          this.tryReadFile(paths, index + 1, res, originalUrl);
          return;
        }

        // 成功读取
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
  }

  /**
   * 处理统一的 Feature 模板路由（新格式）
   * URL 格式: /template/{packageName}/{templateName}.render.js
   * 
   * 统一支持三种来源：
   * 1. 框架内置 Feature：/template/agentdev/visual/capture.render.js
   *    映射到: node_modules/agentdev/dist/features/visual/templates/capture.render.js
   *    或: dist/features/visual/templates/capture.render.js（开发模式）
   * 
   * 2. 外部 npm 包：/template/@agentdev/shell-feature/bash.render.js
   *    映射到: node_modules/@agentdev/shell-feature/dist/templates/bash.render.js
   * 
   * 3. 用户本地 Feature：/template/my-project/visual/capture.render.js
   *    映射到: dist/templates/capture.render.js
   *    或: dist/features/visual/templates/capture.render.js
   */
  public handleUnifiedTemplate(req: IncomingMessage, res: ServerResponse, url: string): void {
    try {
      // 解析 URL: /template/{packageName}/{templateName}.render.js
      // 支持普通包名和 scope 包名（@scope/name）
      // 例如：
      //   - /template/agentdev/visual/capture.render.js -> packageName=agentdev, templateFile=visual/capture.render.js
      //   - /template/@agentdev/visual-feature/capture.render.js -> packageName=@agentdev/visual-feature, templateFile=capture.render.js
      const match = url.match(/^\/template\/((?:@[^/]+\/)?[^/]+)\/(.+\.render\.js)$/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid template path format');
        return;
      }

      const [, packageName, templateFile] = match;
      const templateFileTs = templateFile.replace('.render.js', '.render.ts');

      // 获取当前 Agent 的项目根目录
      const currentSession = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
      const projectRoot = currentSession?.projectRoot || process.cwd();

      // 构建可能的文件路径（按优先级）
      const searchPaths: string[] = [];

      // 1. 外部 npm 包（包括 scope 包）
      if (packageName.startsWith('@')) {
        // scoped package: @scope/name
        searchPaths.push(
          join(projectRoot, 'node_modules', packageName, 'dist', 'templates', templateFile),
          join(projectRoot, 'node_modules', packageName, 'dist', 'templates', templateFileTs),
        );
      } else if (packageName === 'agentdev') {
        // 2. 框架内置 Feature（agentdev 包）
        // 需要从模板名推断 feature 名称
        // 例如: visual/capture.render.js -> feature=visual, template=capture.render.js
        const templateParts = templateFile.split('/');
        if (templateParts.length === 2) {
          const featureName = templateParts[0];
          const templateName = templateParts[1];
          
          searchPaths.push(
            // 开发模式：项目根目录 dist/features/
            join(projectRoot, 'dist', 'features', featureName, 'templates', templateName),
            join(projectRoot, 'dist', 'features', featureName, 'templates', templateName.replace('.js', '.ts')),
            // 源码模式：项目根目录 src/features/
            join(projectRoot, 'src', 'features', featureName, 'templates', templateName.replace('.js', '.ts')),
            // npm 包模式：node_modules/agentdev/dist/features/
            join(projectRoot, 'node_modules', 'agentdev', 'dist', 'features', featureName, 'templates', templateName),
          );
        } else {
          // 兜底：直接在 dist/templates 查找
          searchPaths.push(
            join(projectRoot, 'dist', 'templates', templateFile),
            join(projectRoot, 'dist', 'templates', templateFileTs),
          );
        }
      } else {
        // 3. 用户本地 Feature（其他包名）
        // 尝试在项目的 dist/templates 或 dist/features/*/templates 查找
        searchPaths.push(
          join(projectRoot, 'dist', 'templates', templateFile),
          join(projectRoot, 'dist', 'templates', templateFileTs),
          // 也尝试 feature 子目录
          join(projectRoot, 'dist', 'features', templateFile),
          join(projectRoot, 'dist', 'features', templateFileTs),
          // 源码目录
          join(projectRoot, 'src', 'templates', templateFileTs),
          join(projectRoot, 'src', 'features', templateFileTs),
        );
      }

      // 按顺序尝试每个路径
      this.tryReadFile(searchPaths, 0, res, url);
    } catch (err: any) {
      console.error('[Viewer Worker] Unified template handler error:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  /**
   * 处理 Feature 渲染模板文件
   * 解析路径: /features/shell/trash-delete.render.js
   * 
   * 支持从多个位置查找：
   * 1. 项目根目录 dist/features/{feature}/templates/
   * 2. 项目根目录 src/features/{feature}/templates/
   * 3. npm 包 node_modules/agentdev/dist/features/{feature}/templates/
   * 
   * 支持扩展名映射：
   * - .js → 同时尝试 .js 和 .ts
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
      // 同时尝试 .js 和 .ts 扩展名
      const templateFileTs = templateFile.replace('.render.js', '.render.ts');

      // 获取当前 Agent 的项目根目录
      const currentSession = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
      const projectRoot = currentSession?.projectRoot || process.cwd();

      // 构建可能的文件路径（按优先级）
      const searchPaths = [
        // 1. 项目根目录 dist/features/ (.js 编译后)
        join(projectRoot, 'dist', 'features', featureName, 'templates', templateFile),
        // 2. 项目根目录 dist/features/ (.ts 源码)
        join(projectRoot, 'dist', 'features', featureName, 'templates', templateFileTs),
        // 3. 项目根目录 src/features/ (.ts 源码)
        join(projectRoot, 'src', 'features', featureName, 'templates', templateFileTs),
        // 4. 项目根目录 src/features/ (.js 如果存在)
        join(projectRoot, 'src', 'features', featureName, 'templates', templateFile),
        // 5. npm 包 node_modules/agentdev/dist/features/
        join(projectRoot, 'node_modules', 'agentdev', 'dist', 'features', featureName, 'templates', templateFile),
      ];

      // 按顺序尝试每个路径
      this.tryReadFile(searchPaths, 0, res, url);
    } catch (err: any) {
      console.error('[Viewer Worker] Feature 模板处理错误:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  /**
   * 处理 npm 包中的 Feature 模板
   * 支持两种路径格式：
   * 1. 独立包: /npm/@agentdev/shell-feature/templates/bash.render.js
   *    映射到: node_modules/@agentdev/shell-feature/dist/templates/bash.render.js
   * 2. 框架包: /npm/agentdev/features/shell/bash.render.js
   *    映射到: node_modules/agentdev/dist/features/shell/templates/bash.render.js
   */
  public handleNpmFeatureTemplate(req: IncomingMessage, res: ServerResponse, url: string): void {
    try {
      // 获取当前 Agent 的项目根目录
      const currentSession = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
      const projectRoot = currentSession?.projectRoot || process.cwd();

      let templatePath: string;

      // 模式 1: 独立 npm 包 /npm/@scope/package/templates/xxx.render.js
      const scopedMatch = url.match(/^\/npm\/(@[^/]+\/[^/]+)\/templates\/(.+\.render\.js)$/);
      if (scopedMatch) {
        const [, scopedPackageName, templateFile] = scopedMatch;
        // 构建路径: node_modules/@scope/package/dist/templates/{template}
        templatePath = join(projectRoot, 'node_modules', scopedPackageName, 'dist', 'templates', templateFile);
      } else {
        // 模式 2: 独立 npm 包（无 scope）/npm/package/templates/xxx.render.js
        const simpleMatch = url.match(/^\/npm\/([^/@][^/]*)\/templates\/(.+\.render\.js)$/);
        if (simpleMatch) {
          const [, packageName, templateFile] = simpleMatch;
          templatePath = join(projectRoot, 'node_modules', packageName, 'dist', 'templates', templateFile);
        } else {
          // 模式 3: 框架包 /npm/agentdev/features/shell/bash.render.js
          const frameworkMatch = url.match(/^\/npm\/([^/]+)\/features\/([^/]+)\/(.+\.render\.js)$/);
          if (!frameworkMatch) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Invalid npm feature template path');
            return;
          }
          const [, packageName, featureName, templateFile] = frameworkMatch;
          // 构建路径: node_modules/{package}/dist/features/{feature}/templates/{template}
          templatePath = join(projectRoot, 'node_modules', packageName, 'dist', 'features', featureName, 'templates', templateFile);
        }
      }

      // 读取文件并返回
      import('fs').then((fs) => {
        fs.readFile(templatePath, 'utf-8', (err: any, data: string) => {
          if (err) {
            console.error('[Viewer Worker] 读取 npm Feature 模板失败:', {
              path: templatePath,
              error: err.message
            });
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`npm feature template not found: ${url}`);
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
      console.error('[Viewer Worker] npm Feature 模板处理错误:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  }

  /**
   * 处理静态资源文件（chunk、js、css 等）
   * 支持 agentdev npm 包中的共享模块
   */
  public handleStaticAsset(req: IncomingMessage, res: ServerResponse, url: string): void {
    try {
      // 获取当前 Agent 的项目根目录
      const session = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
      const projectRoot = session?.projectRoot || process.cwd();

      // 提取文件名（去掉开头的 /）
      const fileName = url.substring(1); // 如 /chunk-xxx.js -> chunk-xxx.js

      // 构建搜索路径
      const searchPaths = [
        // npm 包模式：node_modules/agentdev/dist/{file}
        join(projectRoot, 'node_modules', 'agentdev', 'dist', fileName),
        // 开发模式：项目根目录 dist/{file}
        join(projectRoot, 'dist', fileName),
      ];

      // 按顺序尝试每个路径
      this.tryReadFile(searchPaths, 0, res, url);
    } catch (err: any) {
      console.error('[Viewer Worker] 静态资源处理错误:', err.message);
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
