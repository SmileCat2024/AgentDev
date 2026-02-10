/**
 * 消息可视化器 - HTTP 轮询模式
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { type Message } from './types.js';

export class MessageViewer {
  private port: number;
  private server: ReturnType<typeof createServer>;
  private messages: Message[] = [];

  constructor(port: number = 2026) {
    this.port = port;
    this.server = createServer();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 先注册 request 处理器
      this.server.on('request', (req, res) => this.handleRequest(req, res));

      // 错误处理
      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 被占用`));
        } else {
          reject(err);
        }
      });

      // 监听端口
      this.server.listen(this.port, () => {
        const url = `http://localhost:${this.port}`;
        console.log(`[Viewer] ${url}`);

        // 打开浏览器
        import('open').then(open => open.default(url).catch(() => {}));

        resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 主页
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.getHtml());
      return;
    }

    // API 端点
    if (req.url === '/api/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(this.messages));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  push(messages: Message[]): void {
    this.messages = messages;
  }

  stop(): void {
    this.server.close();
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
      --bg-color: #0d1117;
      --header-bg: #161b22;
      --border-color: #30363d;
      --text-primary: #c9d1d9;
      --text-secondary: #8b949e;
      --accent-color: #58a6ff;
      --user-msg-bg: #1f6feb;
      --assistant-msg-bg: #161b22;
      --tool-msg-bg: #0d1117;
      --success-color: #238636;
      --error-color: #da3633;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: #30363d;
      border-radius: 6px;
      border: 2px solid var(--bg-color); /* Creates padding effect */
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #8b949e;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
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
    }

    h1 { font-size: 16px; font-weight: 600; color: var(--text-primary); }
    
    .status-badge {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--success-color);
      color: #ffffff;
      font-weight: 500;
    }
    .status-badge.disconnected { background: var(--error-color); }

    #chat-container {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      padding-bottom: 120px; /* Extra bottom padding as requested */
      display: flex;
      flex-direction: column;
      gap: 24px;
      scroll-behavior: smooth;
    }

    .message-row {
      display: flex;
      flex-direction: column;
      max-width: 900px;
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
      margin-left: 4px;
      margin-right: 4px;
    }

    .role-badge {
      text-transform: uppercase;
      font-weight: 600;
      font-size: 11px;
      letter-spacing: 0.5px;
    }

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
    .collapse-toggle:hover {
      opacity: 1;
      background: rgba(255,255,255,0.1);
    }
    .collapse-toggle svg {
      width: 12px;
      height: 12px;
      fill: currentColor;
      transition: transform 0.2s;
    }

    .message-content {
      padding: 16px;
      border-radius: 12px;
      font-size: 15px;
      line-height: 1.6;
      position: relative;
      overflow-wrap: break-word;
      word-wrap: break-word;
      transition: max-height 0.3s ease;
      overflow: hidden;
    }
    
    .message-content.collapsed {
      max-height: 160px;
      mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
    }

    /* User Message */
    .message-row.user { align-items: flex-end; }
    .message-row.user .message-meta { justify-content: flex-end; }
    .message-row.user .message-content {
      background-color: var(--user-msg-bg);
      color: #ffffff;
      border-bottom-right-radius: 2px;
      max-width: 85%;
    }

    /* Assistant Message - Use Markdown Body Style */
    .message-row.assistant .message-content {
      background-color: var(--assistant-msg-bg);
      border: 1px solid var(--border-color);
      border-bottom-left-radius: 2px;
      width: 100%;
    }
    
    /* Override markdown-body bg for assistant to match our theme */
    .markdown-body {
      background-color: transparent !important;
      font-family: inherit !important;
      font-size: inherit !important;
    }

    /* System Message */
    .message-row.system { align-items: center; gap: 4px; margin: 12px auto; opacity: 0.8; }
    .message-row.system .message-content {
      background: transparent;
      border: 1px dashed var(--border-color);
      padding: 8px 16px;
      font-size: 13px;
      color: var(--text-secondary);
      text-align: center;
    }

    /* Tool Call Container */
    .tool-call-container {
      margin-top: 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      overflow: hidden;
      background: #161b22;
    }
    
    .tool-header {
      background: #21262d;
      padding: 6px 12px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-color);
    }
    .tool-header-name {
        color: var(--text-primary);
        font-weight: 600;
    }

    .tool-content {
      padding: 12px;
      font-size: 13px;
      color: var(--text-primary);
    }

    /* Tool Result Message */
    .message-row.tool .message-content {
      background-color: var(--tool-msg-bg);
      border: 1px solid var(--border-color);
      border-left: 3px solid #8b949e; /* Neutral grey for result */
      padding: 0;
      width: 100%;
    }
    
    .tool-result-header {
      padding: 4px 12px;
      background: #161b22;
      border-bottom: 1px solid var(--border-color);
      font-size: 11px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tool-result-body {
      padding: 12px;
      overflow-x: auto;
    }

    /* Reasoning Block */
    .reasoning-block {
      margin-bottom: 16px;
      border-left: 2px solid #30363d;
      background: rgba(13, 17, 23, 0.5);
      border-radius: 0 4px 4px 0;
      overflow: hidden;
    }

    .reasoning-header {
      padding: 6px 12px;
      cursor: pointer;
      font-size: 11px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
      font-weight: 500;
      transition: color 0.2s;
    }
    .reasoning-header:hover {
      color: var(--text-primary);
    }
    
    .reasoning-icon {
      transition: transform 0.2s;
    }
    .reasoning-block.expanded .reasoning-icon {
      transform: rotate(90deg);
    }

    .reasoning-content {
      display: none;
      padding: 8px 12px 12px 12px;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
      border-top: 1px solid transparent;
    }
    .reasoning-block.expanded .reasoning-content {
      display: block;
      animation: fadeIn 0.2s ease-in-out;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Specific Tool Styles */
    .bash-command {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
      color: #c9d1d9;
    }
    .bash-output {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
      white-space: pre-wrap;
      color: #8b949e;
      font-size: 12px;
      margin-top: 0;
    }
    
    .file-path {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
      color: var(--accent-color);
    }

    .simple-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .simple-list-item {
      display: flex;
      gap: 8px;
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
      font-size: 12px;
    }

    .empty-state {
      text-align: center;
      margin-top: 10vh;
      color: var(--text-secondary);
    }

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

    // Configure Marked
    marked.setOptions({
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
      breaks: true
    });

    function parseToolResult(content) {
      try {
        const json = JSON.parse(content);
        if (json && typeof json === 'object' && 'success' in json && 'result' in json) {
          return { success: json.success, data: json.result };
        }
        return { success: true, data: content };
      } catch (e) {
        return { success: true, data: content };
      }
    }

    const TOOL_NAMES = {
      run_shell_command: 'Bash',
      read_file: 'Read File',
      write_file: 'Write File',
      list_directory: 'LS',
      web_fetch: 'Web',
      calculator: 'Calc'
    };

    const toolRenderers = {
      read_file: {
        call: (args) => \`<div class="bash-command">Read <span class="file-path">\${args.path}</span></div>\`,
        result: (data) => \`<pre class="bash-output" style="max-height:300px;">\${data}</pre>\`
      },
      write_file: {
        call: (args) => \`<div class="bash-command">Write <span class="file-path">\${args.path}</span></div>\`,
        result: (data) => \`<div style="color:var(--success-color)">✓ File written successfully</div>\`
      },
      list_directory: {
        call: (args) => \`<div class="bash-command">LS <span class="file-path">\${args.path || '.'}</span></div>\`,
        result: (data) => {
          const files = data.split('\\n').filter(f => f);
          return \`<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:4px; font-family:monospace; font-size:12px;">
            \${files.map(f => \`<div style="color:var(--text-primary);">\${f}</div>\`).join('')}
          </div>\`;
        }
      },
      run_shell_command: {
        call: (args) => \`<div class="bash-command">> \${args.command}</div>\`,
        result: (data) => \`<pre class="bash-output">\${data}</pre>\`
      },
      web_fetch: {
        call: (args) => \`<div>GET <a href="\${args.url}" target="_blank" style="color:var(--accent-color)">\${args.url}</a></div>\`,
        result: (data) => \`<div style="font-size:12px; opacity:0.8;">Fetched \${data.length} chars</div>\`
      },
      calculator: {
        call: (args) => \`<div class="bash-command">\${args.expression}</div>\`,
        result: (data) => \`<div class="bash-command" style="color:#d2a8ff">= \${data}</div>\`
      }
    };

    async function poll() {
      try {
        const res = await fetch('/api/messages');
        const messages = await res.json();
        
        if (JSON.stringify(messages) !== JSON.stringify(currentMessages)) {
          currentMessages = messages;
          render(messages);
          statusBadge.textContent = 'Connected';
          statusBadge.classList.remove('disconnected');
        }
      } catch (e) {
        statusBadge.textContent = 'Disconnected';
        statusBadge.classList.add('disconnected');
      }
      setTimeout(poll, 1000);
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
          
          // Reasoning Block
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
              const displayName = TOOL_NAMES[call.name] || call.name;
              let innerHtml;
              
              if (toolRenderers[call.name] && toolRenderers[call.name].call) {
                innerHtml = toolRenderers[call.name].call(call.arguments);
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
          // Find corresponding tool call
          for (const m of messages) {
            if (m.toolCalls) {
              const found = m.toolCalls.find(c => c.id === toolCallId);
              if (found) { toolName = found.name; break; }
            }
          }

          const { success, data } = parseToolResult(msg.content);
          const displayName = TOOL_NAMES[toolName] || toolName || 'Tool Result';

          let bodyHtml;
          if (toolName && toolRenderers[toolName] && toolRenderers[toolName].result) {
             bodyHtml = toolRenderers[toolName].result(data, success);
          } else {
             const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
             bodyHtml = \`<pre class="bash-output">\${displayData}</pre>\`;
          }
          
          contentHtml = \`
            <div class="message-content" id="\${msgId}" style="padding:0; overflow:hidden;">
              <div class="tool-result-header">
                <span>\${displayName}</span>
                \${!success ? '<span style="color:var(--error-color)">Failed</span>' : ''}
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
      
      // Auto-collapse large messages
      document.querySelectorAll('.message-row').forEach(row => {
        const el = row.querySelector('.message-content');
        if (!el) return;

        // Check if content is large enough to be collapsible
        const isCollapsible = el.scrollHeight > 160;
        
        // Determine if it should be collapsed by default
        // Only collapse 'system' messages by default
        const isSystem = row.classList.contains('system');
        const shouldCollapse = isCollapsible && isSystem;

        if (isCollapsible) {
           if (shouldCollapse) {
             el.classList.add('collapsed');
             const meta = row.querySelector('.message-meta .collapse-toggle svg');
             if (meta) meta.style.transform = 'rotate(-90deg)';
           } else {
             // Ensure it is expanded (no 'collapsed' class)
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

    poll();
  </script>
</body>
</html>`;
  }
}
