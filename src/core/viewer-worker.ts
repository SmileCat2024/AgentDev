
/**
 * Viewer Worker - 在独立进程中运行 HTTP 服务器
 * 支持多 Agent 调试，共享单端口
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { type Message, type Tool, AgentSession, DebugHubIPCMessage, ToolMetadata } from './types.js';
import {
  RENDER_TEMPLATES,
  SYSTEM_RENDER_MAP,
  TOOL_DISPLAY_NAMES,
  getToolRenderConfig
} from './render.js';

// ============= Worker 类 =============

class ViewerWorker {
  private port: number;
  private server: ReturnType<typeof createServer>;

  // 多 Agent 会话存储
  private agentSessions: Map<string, AgentSession> = new Map();

  // 当前选中的 Agent ID
  private currentAgentId: string | null = null;

  // 内存限制配置
  private readonly MAX_MESSAGES = 10000;
  private readonly MAX_BYTES = 50 * 1024 * 1024; // 50MB

  constructor(port: number) {
    this.port = port;
    this.server = createServer();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
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

        // 打开浏览器
        try {
          const open = await import('open');
          await open.default(url).catch(() => {
            console.warn('[Viewer Worker] 浏览器打开失败，请手动访问: ' + url);
          });
        } catch {
          console.warn('[Viewer Worker] open 模块不可用，请手动访问: ' + url);
        }

        // 通知主进程服务器已启动
        if (process.send) {
          process.send({ type: 'ready' });
        }

        resolve();
      });
    });
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
  public handleRegisterAgent(msg: any): void {
    const { agentId, name, createdAt } = msg;
    this.getOrCreateSession(agentId, name);

    // 首个 Agent 自动成为当前
    if (this.agentSessions.size === 1) {
      this.currentAgentId = agentId;
    }

    console.log(`[Viewer Worker] Agent 已注册: ${agentId} (${name})`);
  }

  /**
   * 处理推送消息
   */
  public handlePushMessages(msg: any): void {
    const { agentId, messages } = msg;
    const session = this.agentSessions.get(agentId);
    if (session) {
      session.messages = messages;
      this.updateSessionActivity(agentId);
      this.enforceMemoryLimits(session);
    }
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
  <style>
    :root {
      --bg-color: #000000;
      --sidebar-bg: #0a0a0a;
      --header-bg: #0a0a0a;
      --border-color: #222;
      --text-primary: #ededed;
      --text-secondary: #888;
      --accent-color: #ededed;
      --user-msg-bg: #1a1a1a;
      --assistant-msg-bg: #000000;
      --tool-msg-bg: #050505;
      --success-color: #198754;
      --error-color: #dc3545;
      --hover-bg: #1f1f1f;
      --active-bg: #2a2a2a;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #555; }

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

    /* Main Content */
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      background-color: var(--bg-color);
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
      color: #fff;
      font-weight: 500;
    }
    .status-badge.disconnected { background: var(--error-color); }

    #chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      padding-bottom: 100px;
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
  </div>

  <script>
    const container = document.getElementById('chat-container');
    const statusBadge = document.getElementById('connection-status');
    const agentList = document.getElementById('agent-list');
    const currentAgentTitle = document.getElementById('current-agent-name');
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');

    let currentAgentId = null;
    let allAgents = [];
    let currentMessages = [];
    let toolRenderConfigs = {};
    let TOOL_NAMES = {};

    // Sidebar Toggle
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
    });

    marked.setOptions({
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

    const RENDER_TEMPLATES = {
      'file': {
        call: (args) => \`<div class="bash-command">Read <span class="file-path">\${args.path}</span></div>\`,
        result: (data, success, args) => {
          if (!success) return formatError(data);
          const path = args?.path || '';
          const ext = path.split('.').pop().toLowerCase();
          const str = String(data);
          
          if (ext === 'md' || ext === 'markdown') {
             return \`<div class="file-content markdown-body" style="padding:12px; background:#0d1117; border-radius:6px; font-size:13px; max-height:600px; overflow-y:auto;">\${marked.parse(str)}</div>\`;
          }
          
          const codeExts = ['js', 'ts', 'py', 'java', 'c', 'cpp', 'rs', 'go', 'json', 'html', 'css', 'sh', 'bash', 'yaml', 'yml', 'xml', 'sql'];
          if (codeExts.includes(ext)) {
             const lang = ext === 'ts' ? 'typescript' : (ext === 'js' ? 'javascript' : (ext === 'py' ? 'python' : ext));
             let highlighted;
             try {
               highlighted = hljs.highlight(str, { language: lang }).value;
             } catch (e) {
               highlighted = hljs.highlightAuto(str).value;
             }
             return \`<pre class="bash-output" style="max-height:500px; overflow:auto; background:#0d1117; padding:12px; border-radius:6px;"><code>\${highlighted}</code></pre>\`;
          }
          
          return \`<pre class="bash-output" style="max-height:300px;">\${escapeHtml(str)}</pre>\`;
        }
      },
      'file-write': {
        call: (args) => \`<div class="bash-command">Write <span class="file-path">\${args.path}</span></div>\`,
        result: (data, success) => {
          if (!success) return formatError(data);
          return \`<div style="color:var(--success-color)">✓ File written successfully</div>\`;
        }
      },
      'file-list': {
        call: (args) => \`<div class="bash-command">List <span class="file-path">\${args.path || '.'}</span></div>\`,
        result: (data, success) => {
          if (!success) return formatError(data);
          let str = String(data || '');
          if (str.includes('\\\\n')) str = str.replace(/\\\\n/g, '\\n');
          const files = str.split('\\n').filter(f => f.trim());
          
          if (files.length === 0) return \`<div style="color:var(--text-secondary); font-style:italic; padding:8px;">Empty directory</div>\`;
          return \`<div class="ls-grid">
            \${files.map(f => {
              return \`<div class="ls-item">
                <span class="ls-icon">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="opacity:0.7"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
                </span>
                <span class="ls-name" title="\${escapeHtml(f)}">\${escapeHtml(f)}</span>
              </div>\`;
            }).join('')}
          </div>\`;
        }
      },
      'command': {
        call: (args) => \`<div class="bash-command">> \${args.command}</div>\`,
        result: (data, success) => {
          if (!success) return formatError(data);
          return \`<pre class="bash-output">\${escapeHtml(data)}</pre>\`;
        }
      },
      'web': {
        call: (args) => \`<div>GET <a href="\${args.url}" target="_blank" style="color:var(--accent-color)">\${args.url}</a></div>\`,
        result: (data, success) => {
          if (!success) return formatError(data);
          return \`<div style="font-size:12px; opacity:0.8;">Fetched \${String(data).length} chars</div>\`;
        }
      },
      'math': {
        call: (args) => \`<div class="bash-command">\${args.expression}</div>\`,
        result: (data, success) => {
           if (!success) return formatError(data);
           return \`<div class="bash-command" style="color:#d2a8ff">= \${escapeHtml(data)}</div>\`;
        }
      },
      'skill': {
        call: (args) => \`<div class="bash-command">Invoke Skill <span class="file-path">\${escapeHtml(args.skill || '')}</span></div>\`,
        result: (data, success) => {
          if (!success) return formatError(data);
          const str = String(data);
          // invoke_skill 返回的是 markdown 格式的技能文档，直接用 markdown 渲染
          return \`<div class="file-content markdown-body" style="padding:12px; background:#0d1117; border-radius:6px; font-size:13px; max-height:600px; overflow-y:auto;">\${marked.parse(str)}</div>\`;
        }
      },
      'json': {
        call: (args) => \`<pre style="margin:0; font-size:12px;">\${escapeHtml(JSON.stringify(args, null, 2))}</pre>\`,
        result: (data, success) => {
          if (!success) return formatError(data);
          const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
          return \`<pre class="bash-output">\${escapeHtml(displayData)}</pre>\`;
        }
      }
    };

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

    function getToolRenderTemplate(toolName) {
      const config = toolRenderConfigs[toolName];
      const callTemplateName = (config?.render?.call) || 'json';
      const resultTemplateName = (config?.render?.result) || 'json';

      // 检查是否为内联模板
      const callIsInline = callTemplateName === '__inline__';
      const resultIsInline = resultTemplateName === '__inline__';

      const callTemplate = callIsInline
        ? { call: config?.render?.inlineCall, result: config?.render?.inlineCall }
        : (RENDER_TEMPLATES[callTemplateName] || RENDER_TEMPLATES['json']);
      const resultTemplate = resultIsInline
        ? { call: config?.render?.inlineResult, result: config?.render?.inlineResult }
        : (RENDER_TEMPLATES[resultTemplateName] || RENDER_TEMPLATES['json']);

      return {
        call: callTemplate.call,
        result: resultTemplate.result,
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
        return \`
          <div class="agent-item \${isActive ? 'active' : ''}" onclick="switchAgent('\${a.id}')">
            <div class="agent-name">\${escapeHtml(a.name)}</div>
            <div class="agent-meta">#\${a.id.split('-')[1] || a.id} · \${a.messageCount} msgs</div>
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

        render(currentMessages);
      } catch (e) {
        console.error('Failed to load agent data:', e);
      }
    }

    async function poll() {
      try {
        if (!currentAgentId) {
          await loadAgents();
          setTimeout(poll, 1000);
          return;
        }

        // 并行请求消息和通知
        const [msgsRes, notifRes] = await Promise.all([
          fetch(\`/api/agents/\${currentAgentId}/messages\`),
          fetch(\`/api/agents/\${currentAgentId}/notification\`),
        ]);

        const data = await msgsRes.json();
        const messages = data.messages || [];

        // 处理通知状态
        const notifData = await notifRes.json();
        updateNotificationStatus(notifData);

        if (messages.length !== currentMessages.length || messages.length === 0) {
          currentMessages = messages;
          render(messages);
          statusBadge.textContent = 'Connected';
          statusBadge.classList.remove('disconnected');
        } else {
          const lastMsgChanged = messages.length > 0 &&
            JSON.stringify(messages[messages.length - 1]) !== JSON.stringify(currentMessages[currentMessages.length - 1]);
          if (lastMsgChanged) {
            currentMessages = messages;
            render(messages);
          }
        }

        // Also refresh agent list occasionally to get new agents
        if (Math.random() < 0.1) {
           const agentsRes = await fetch('/api/agents');
           const agentsData = await agentsRes.json();
           if (JSON.stringify(agentsData.agents) !== JSON.stringify(allAgents)) {
             allAgents = agentsData.agents || [];
             renderAgentList();
           }
        }

      } catch (e) {
        statusBadge.textContent = 'Disconnected';
        statusBadge.classList.add('disconnected');
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
          }
          contentHtml = \`<div class="message-content markdown-body" id="\${msgId}" style="\${style}">\${marked.parse(msg.content)}</div>\`;
          
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

          innerContent += \`<div class="markdown-body">\${marked.parse(msg.content)}</div>\`;

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
        const shouldCollapse = isCollapsible && isSystem;

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

    loadAgents().then(() => {
      poll();
    });
  </script>
</body>
</html>`;
  }
}

// ========== Worker 进程入口 ==========

const port = parseInt(process.argv[2] || '2026', 10);
const worker = new ViewerWorker(port);

// 立即启动服务器
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
