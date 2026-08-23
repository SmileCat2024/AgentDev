export const VIEWER_JS_AGENTS = `
    // 焦点自持：服务端不再有"当前 Agent"概念，焦点由本页持有并持久化。
    // 恢复优先级：活跃输入请求 > localStorage 记忆 > 第一个 connected agent。
    function restoreFocus(agents) {
      const pendingInput = agents.find(a => a.connected !== false && a.pendingInputCount > 0);
      if (pendingInput) return pendingInput.id;
      try {
        const remembered = localStorage.getItem('agentdev-last-focused-agent');
        if (remembered && agents.some(a => a.id === remembered)) return remembered;
      } catch (e) { /* localStorage 不可用时跳过记忆 */ }
      const connected = agents.find(a => a.connected !== false);
      if (connected) return connected.id;
      return agents.length > 0 ? agents[0].id : null;
    }

    function persistFocus(agentId) {
      try {
        if (agentId) localStorage.setItem('agentdev-last-focused-agent', agentId);
        else localStorage.removeItem('agentdev-last-focused-agent');
      } catch (e) { /* ignore */ }
    }

    async function loadAgents() {
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        allAgents = data.agents || [];

        // 焦点为空时初始化（页面首次加载 / 全部 agent 被清空后重新出现）
        if (!currentAgentId && allAgents.length > 0) {
          const restored = restoreFocus(allAgents);
          if (restored) {
            currentAgentId = restored;
            setFollowLatest(true);
            await loadAgentData(currentAgentId);
          }
        }

        renderAgentList();
        renderFeaturePanel();
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
      currentAgentId = newAgentId;   // 焦点前端自持，直接切换
      persistFocus(newAgentId);
      setFollowLatest(true);
      await loadAgentData(newAgentId);
      renderAgentList(); // Update active state
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

        // 被删的是焦点 agent：按焦点恢复算法自选下一个
        if (contextMenuAgentId === currentAgentId) {
          currentAgentId = allAgents.length > 0 ? restoreFocus(allAgents) : null;
          if (currentAgentId) {
            persistFocus(currentAgentId);
            await loadAgentData(currentAgentId);
          } else {
            persistFocus(null);
            currentMessages = [];
            setCurrentLogs([]);
            setCurrentHookInspector({ lifecycleOrder: [], features: [], hooks: [] });
            setCurrentOverviewSnapshot(getEmptyOverviewSnapshot());
            container.innerHTML = getEmptyStateHtml();
            setFollowLatest(true);
            currentAgentTitle.textContent = t('page_title');
          }
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
      if (logPanelScope === 'current' && !currentAgentId) {
        return;
      }
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

`;
