
/**
 * 消息可视化器 - HTTP 轮询模式
 * 支持独立进程运行，避免主线程阻塞影响 HTTP 响应
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { fork, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { type Message, type Tool } from './types.js';
import {
  RENDER_TEMPLATES,
  SYSTEM_RENDER_MAP,
  TOOL_DISPLAY_NAMES,
  applyTemplate,
  getToolRenderTemplate,
  getToolDisplayName,
  getToolRenderConfig
} from './render.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 工具元数据（用于前端渲染）
 */
interface ToolMetadata {
  name: string;
  description: string;
  render: {
    call: string;  // 模板名称，必需
    result: string;  // 模板名称，必需
  };
}

export class MessageViewer {
  private port: number;
  private server: ReturnType<typeof createServer> | null = null;
  private messages: Message[] = [];
  private registeredTools: Map<string, ToolMetadata> = new Map();
  private worker: any = null;
  private useWorkerMode: boolean = true;  // 默认使用独立进程模式

  constructor(port: number = 2026, useWorkerMode: boolean = true) {
    this.port = port;
    this.useWorkerMode = useWorkerMode;
    if (!useWorkerMode) {
      this.server = createServer();
    }
  }

  async start(): Promise<void> {
    if (this.useWorkerMode) {
      return this.startWorkerMode();
    }
    return this.startDirectMode();
  }

  /**
   * 独立进程模式 - HTTP 服务器在子进程中运行
   * 主进程阻塞时仍可响应 HTTP 请求
   */
  private async startWorkerMode(): Promise<void> {
    return new Promise((resolve, reject) => {
      // __dirname 在编译后指向 dist/core/
      const workerPath = join(__dirname, 'viewer-worker.js');

      // 直接 fork 编译后的 JS 文件
      this.worker = fork(workerPath, [String(this.port)], {
        silent: false,
      });

      // 等待 worker 准备就绪
      const onReady = (msg: any) => {
        if (msg.type === 'ready') {
          this.worker.off('message', onReady);
          console.log(`[Viewer] Worker 进程已启动，端口: ${this.port}`);
          resolve();
        }
      };

      this.worker.on('message', onReady);

      // 错误处理
      this.worker.on('error', (err: any) => {
        reject(new Error(`Worker 启动失败: ${err.message}`));
      });

      this.worker.on('exit', (code: number) => {
        if (code !== 0) {
          reject(new Error(`Worker 异常退出，代码: ${code}`));
        }
      });
    });
  }

  /**
   * 直接模式 - HTTP 服务器在主进程中运行（原有逻辑）
   */
  private async startDirectMode(): Promise<void> {
    if (!this.server) {
      this.server = createServer();
    }
    const server = this.server!;  // TypeScript non-null assertion
    return new Promise((resolve, reject) => {
      // 先注册 request 处理器
      server.on('request', (req, res) => this.handleRequest(req, res));

      // 错误处理
      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 被占用`));
        } else {
          reject(err);
        }
      });

      // 监听端口
      server.listen(this.port, async () => {
        const url = `http://localhost:${this.port}`;
        console.log(`[Viewer] ${url}`);

        // 打开浏览器（等待完成，但失败不影响服务器运行）
        try {
          const open = await import('open');
          await open.default(url).catch(() => {
            // 浏览器打开失败不影响服务器运行
            console.warn('[Viewer] 浏览器打开失败，请手动访问: ' + url);
          });
        } catch {
          // open 模块不可用时，服务器继续运行
          console.warn('[Viewer] open 模块不可用，请手动访问: ' + url);
        }

        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Worker 模式下，由子进程处理请求
    if (this.useWorkerMode) {
      res.writeHead(503);
      res.end('Service running in worker mode');
      return;
    }

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 主页
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.getHtml());
      return;
    }

    // API 端点 - 消息
    if (req.url === '/api/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.messages));
      return;
    }

    // API 端点 - 工具元数据
    if (req.url === '/api/tools') {
      const tools = Array.from(this.registeredTools.values());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(tools));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  push(messages: Message[]): void {
    this.messages = messages;
    // 如果是 worker 模式，发送 IPC 消息
    if (this.useWorkerMode && this.worker) {
      this.worker.send({ type: 'push', messages });
    }
  }

  stop(): void {
    if (this.useWorkerMode && this.worker) {
      this.worker.send({ type: 'stop' });
    } else if (this.server) {
      this.server.close();
    }
  }

  /**
   * 注册工具元数据到viewer
   */
  registerTools(tools: Tool[]): void {
    for (const tool of tools) {
      // 获取工具的渲染配置（模板名称）
      const config = getToolRenderConfig(tool.name, tool.render);

      // 确保模板名称不为空
      const callTemplate = config.call || 'json';
      const resultTemplate = config.result || 'json';

      // 构建工具元数据 - 传输模板名称，而不是模板内容
      this.registeredTools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        render: {
          call: callTemplate,    // 模板名称，如 'command', 'file'
          result: resultTemplate, // 模板名称
        },
      });

      // 同时注册显示名称
      if (!TOOL_DISPLAY_NAMES[tool.name]) {
        (TOOL_DISPLAY_NAMES as Record<string, string>)[tool.name] = tool.name;
      }
    }

    // 如果是 worker 模式，发送 IPC 消息
    if (this.useWorkerMode && this.worker) {
      this.worker.send({ type: 'register-tools', tools });
    }
  }

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
      flex-direction: column;
      overflow: hidden;
      font-size: 14px;
    }

    header {
      background-color: var(--header-bg);
      border-bottom: 1px solid var(--border-color);
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
      z-index: 10;
      height: 56px;
    }

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

    .collapse-toggle {
      cursor: pointer;
      opacity: 0.6;
      transition: opacity 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 4px;
    }
    .collapse-toggle:hover { opacity: 1; background: var(--hover-bg); }
    .collapse-toggle svg { width: 12px; height: 12px; fill: currentColor; transition: transform 0.2s; }

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
    }

    .message-row.user { align-items: flex-end; }
    .message-row.user .message-meta { justify-content: flex-end; }
    .message-row.user .message-content {
      background-color: var(--user-msg-bg);
      color: var(--text-primary);
      border-bottom-right-radius: 2px;
      max-width: 85%;
    }

    .message-row.assistant .message-content {
      background-color: transparent;
      padding: 0;
      width: 100%;
    }
    
    .markdown-body { color: var(--text-primary) !important; font-family: inherit !important; background: transparent !important; }
    .markdown-body pre { background-color: #111 !important; border-radius: 6px; }

    .message-row.system { align-items: center; gap: 4px; margin: 12px auto; opacity: 0.8; }
    .message-row.system .message-content {
      background: transparent;
      border: 1px dashed var(--border-color);
      padding: 8px 16px;
      font-size: 13px;
      color: var(--text-secondary);
      text-align: center;
    }

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
    .ls-item:hover { background: var(--active-bg); border-color: #444; transform: translateY(-1px); }
    .ls-icon { color: var(--text-secondary); display: flex; align-items: center; }
    .ls-name { font-family: "Fira Code", "Cascadia Code", "Source Code Pro", "JetBrains Mono", ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }

    .markdown-body table {
      width: 100% !important;
      border-collapse: collapse !important;
      margin-bottom: 16px !important;
      background-color: #161b22 !important;
      border-radius: 6px !important;
      overflow: hidden !important;
      display: table !important; /* Override potential display:block from some markdown css */
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

    .empty-state { text-align: center; margin-top: 20vh; color: var(--text-secondary); }

  </style>
</head>
<body>
  <header>
    <h1>Agent Debugger</h1>
    <span id="connection-status" class="status-badge">Connected</span>
  </header>
  
  <div id="chat-container">
    <div class="empty-state">Waiting for messages...</div>
  </div>

  <script>
    const container = document.getElementById('chat-container');
    const statusBadge = document.getElementById('connection-status');
    let currentMessages = [];
    let toolRenderConfigs = {};
    let TOOL_NAMES = {};

    marked.setOptions({
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
      breaks: true
    });

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
      'json': {
        call: (args) => \`<pre style="margin:0; font-size:12px;">\${escapeHtml(JSON.stringify(args, null, 2))}</pre>\`,
        result: (data, success) => {
          if (!success) return formatError(data);
          const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
          return \`<pre class="bash-output">\${escapeHtml(displayData)}</pre>\`;
        }
      }
    };

    function escapeHtml(text) {
      const str = String(text);
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return str.replace(/[&<>"']/g, m => map[m]);
    }

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
                // If the string starts with a quote or bracket/brace, it might be a JSON string
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
      const callTemplateName = (config?.render?.call) || SYSTEM_RENDER_MAP[toolName] || 'json';
      const resultTemplateName = (config?.render?.result) || SYSTEM_RENDER_MAP[toolName] || 'json';
      const callTemplate = RENDER_TEMPLATES[callTemplateName] || RENDER_TEMPLATES['json'];
      const resultTemplate = RENDER_TEMPLATES[resultTemplateName] || RENDER_TEMPLATES['json'];
      return {
        call: callTemplate.call,
        result: resultTemplate.result
      };
    }

    function getToolDisplayName(toolName) {
      return TOOL_NAMES[toolName] || toolName;
    }

    const SYSTEM_RENDER_MAP = {
      read_file: 'file',
      write_file: 'file-write',
      list_directory: 'file-list',
      run_shell_command: 'command',
      web_fetch: 'web',
      calculator: 'math',
    };

    async function loadToolsConfig() {
      try {
        const res = await fetch('/api/tools');
        const tools = await res.json();
        const DEFAULT_DISPLAY_NAMES = {
          run_shell_command: 'Bash',
          read_file: 'Read File',
          write_file: 'Write File',
          list_directory: 'List',
          web_fetch: 'Web',
          calculator: 'Calc'
        };
        for (const tool of tools) {
          toolRenderConfigs[tool.name] = tool;
          TOOL_NAMES[tool.name] = DEFAULT_DISPLAY_NAMES[tool.name] || tool.name;
        }
      } catch (e) {
        console.error('Failed to load tools config:', e);
      }
    }

    async function poll() {
      try {
        const res = await fetch('/api/messages');
        const messages = await res.json();
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
      } catch (e) {
        statusBadge.textContent = 'Disconnected';
        statusBadge.classList.add('disconnected');
      }
      setTimeout(poll, 100);
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
        
        metaHtml += \`
          <div class="collapse-toggle" onclick="toggleMessage('\${msgId}')" title="Toggle content">
            <svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
          </div>
        \`;

        if (role === 'user' || role === 'system') {
          contentHtml = \`<div class="message-content markdown-body" id="\${msgId}">\${marked.parse(msg.content)}</div>\`;
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
             const meta = row.querySelector('.message-meta .collapse-toggle svg');
             if (meta) meta.style.transform = 'rotate(-90deg)';
           } else {
             el.classList.remove('collapsed');
             const meta = row.querySelector('.message-meta .collapse-toggle svg');
             if (meta) meta.style.transform = 'rotate(0deg)';
           }
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
        const meta = el.parentElement.querySelector('.message-meta .collapse-toggle svg');
        if (meta) {
           meta.style.transform = el.classList.contains('collapsed') ? 'rotate(-90deg)' : 'rotate(0deg)';
        }
      }
    };
    
    window.toggleReasoning = function(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle('expanded');
      }
    };

    loadToolsConfig().then(() => {
      poll();
    });
  </script>
</body>
</html>`;
  }
}
