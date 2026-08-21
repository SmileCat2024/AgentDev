export const VIEWER_CSS = `  <style>
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

    .feature-badge.status-removed {
      color: #fff1f2;
      background: rgba(190, 18, 60, 0.72);
      border-color: rgba(225, 29, 72, 0.75);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    }

    .feature-badge.status-superseded {
      color: #f5f5f4;
      background: rgba(120, 113, 108, 0.72);
      border-color: rgba(168, 162, 158, 0.75);
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

    body[data-theme="light"] .feature-badge.status-removed {
      color: #881337;
      background: rgba(255, 228, 230, 1);
    }

    body[data-theme="light"] .feature-badge.status-superseded {
      color: #57534e;
      background: rgba(231, 229, 228, 1);
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
      overflow-y: auto;
      max-height: 400px;
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

    /* 修复行号不随内容滚动的问题：将 absolute 改为 sticky */
    .d2h-code-side-linenumber {
      position: sticky !important;
      left: 0 !important;
      z-index: 1 !important;
    }
    .d2h-code-linenumber {
      position: sticky !important;
      left: 0 !important;
      z-index: 1 !important;
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

    #user-input-container.choice-input-active {
      top: 56px;
      bottom: 0;
      padding: 24px;
      align-items: center;
      background: rgba(5, 7, 12, 0.64);
      backdrop-filter: blur(5px);
      pointer-events: auto;
    }

    body[data-theme="light"] #user-input-container.choice-input-active {
      background: rgba(18, 20, 26, 0.32);
    }

    #user-input-container.choice-input-active.choice-collapsed {
      top: auto;
      bottom: 22px;
      padding: 0 24px;
      align-items: flex-end;
      background: transparent;
      backdrop-filter: none;
      pointer-events: none;
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

    .user-choice-card {
      gap: 12px;
      padding: 18px 20px;
      border-radius: 20px;
      width: min(100%, 520px);
      max-height: min(100%, 720px);
      overflow: auto;
      box-shadow: 0 28px 70px rgba(0, 0, 0, 0.38);
    }

    .user-choice-card:focus {
      outline: none;
      border-color: var(--input-card-border);
    }

    .user-choice-topline {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }

    .user-choice-title {
      flex: 1;
      min-width: 0;
      color: var(--text-primary);
      font-size: 18px;
      line-height: 1.45;
      font-weight: 700;
    }

    .user-choice-progress {
      margin-left: auto;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.4;
      white-space: nowrap;
      padding-top: 1px;
    }

    .user-choice-question {
      color: var(--text-secondary);
      font-size: 15px;
      line-height: 1.55;
    }

    .user-choice-close {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
      flex-shrink: 0;
      font-size: 18px;
      line-height: 1;
    }

    .user-choice-close:hover {
      background: var(--hover-bg);
    }

    .user-choice-options {
      display: grid;
      gap: 8px;
    }

    .user-choice-option {
      width: 100%;
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      gap: 10px;
      align-items: flex-start;
      border: 1px solid var(--border-color);
      background: transparent;
      color: var(--text-primary);
      border-radius: 12px;
      padding: 10px 12px;
      cursor: pointer;
      font-family: inherit;
      text-align: left;
      transition: border-color 0.16s ease, background 0.16s ease;
    }

    .user-choice-option:hover,
    .user-choice-option.active {
      border-color: var(--text-secondary);
      background: var(--hover-bg);
    }

    .user-choice-key {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      line-height: 1;
      margin-top: 1px;
    }

    .user-choice-option.active .user-choice-key {
      color: var(--text-primary);
      border-color: var(--text-primary);
    }

    .user-choice-label {
      font-size: 14px;
      line-height: 1.35;
      color: var(--text-primary);
      overflow-wrap: anywhere;
    }

    .user-choice-description {
      margin-top: 3px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }

    .user-choice-custom {
      display: none;
      margin-top: -2px;
    }

    .user-choice-custom.active {
      display: block;
    }

    .user-choice-custom textarea,
    .user-choice-supplement textarea {
      width: 100%;
      min-height: 42px;
      max-height: 140px;
      resize: none;
      box-sizing: border-box;
      border: 1px solid var(--border-color);
      background: transparent;
      color: var(--text-primary);
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      font-size: 14px;
      line-height: 1.45;
      outline: none;
    }

    .user-choice-custom textarea:focus,
    .user-choice-supplement textarea:focus {
      border-color: var(--text-secondary);
    }

    .user-choice-supplement {
      display: none;
      margin-top: -2px;
    }

    .user-choice-supplement.active {
      display: block;
    }

    .user-choice-supplement-label {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    .user-choice-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.4;
    }

    .user-choice-submit {
      border: 1px solid var(--text-primary);
      background: var(--text-primary);
      color: var(--bg-primary);
      border-radius: 999px;
      padding: 7px 14px;
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
    }

    .user-choice-mini {
      pointer-events: auto;
      width: min(100% - 24px, 420px);
      border: 1px solid var(--input-card-border);
      background: var(--input-card-bg);
      color: var(--text-primary);
      border-radius: 999px;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      box-shadow: 0 10px 32px var(--shadow-strong);
      cursor: pointer;
      font-family: inherit;
      text-align: left;
    }

    .user-choice-mini-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      line-height: 1.4;
    }

    .user-choice-mini-meta {
      color: var(--text-muted);
      font-size: 12px;
      white-space: nowrap;
    }

  </style>
`;
