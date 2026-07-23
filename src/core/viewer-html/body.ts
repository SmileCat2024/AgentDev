export const VIEWER_BODY = `<body>
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

`;
