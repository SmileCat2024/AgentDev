export const VIEWER_JS_AGENTS = `
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

`;
