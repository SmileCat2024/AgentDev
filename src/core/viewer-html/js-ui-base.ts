export const VIEWER_JS_UI_BASE = `
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

`;
