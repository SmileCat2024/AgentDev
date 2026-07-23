export const VIEWER_JS_POLL = `    async function loadAgentData(agentId) {
      try {
        const [msgsRes, toolsRes, hooksRes, overviewRes] = await Promise.all([
          fetch(\`/api/agents/\${agentId}/messages\`),
          fetch(\`/api/agents/\${agentId}/tools\`),
          fetch(\`/api/agents/\${agentId}/hooks\`),
          fetch(\`/api/agents/\${agentId}/overview\`)
        ]);

        const msgsData = await msgsRes.json();
        const tools = await toolsRes.json();
        setCurrentHookInspector(await hooksRes.json());
        setCurrentOverviewSnapshot(await overviewRes.json());

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
        setFollowLatest(true, { scroll: true, behavior: 'auto' });
        if (activeFeaturePanel === 'logs') {
          await loadLogs(true);
        }
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
          if (activeFeaturePanel === 'logs' && logPanelScope === 'all') {
            await loadLogs();
          }
          setTimeout(poll, 1000);
          return;
        }

        // 并行请求消息、通知和输入请求
        const [msgsRes, notifRes, connectionRes, inputRes, overviewRes] = await Promise.all([
          fetch(\`/api/agents/\${currentAgentId}/messages\`),
          fetch(\`/api/agents/\${currentAgentId}/notification\`),
          fetch(\`/api/agents/\${currentAgentId}/connection\`),
          fetch(\`/api/agents/\${currentAgentId}/input-requests\`),
          fetch(\`/api/agents/\${currentAgentId}/overview\`),
        ]);

        const connectionData = await connectionRes.json();
        setConnectionStatus(!!connectionData.connected);

        const data = await msgsRes.json();
        const messages = data.messages || [];

        // 处理通知状态
        const notifData = await notifRes.json();
        updateNotificationStatus(notifData);

        const nextOverview = normalizeOverviewSnapshot(await overviewRes.json());
        const nextOverviewSignature = getOverviewSignature(nextOverview);
        if (nextOverviewSignature !== currentOverviewSignature) {
          currentOverviewSnapshot = nextOverview;
          currentOverviewSignature = nextOverviewSignature;
          if (activeFeaturePanel === 'workspace') {
            renderFeaturePanel();
          }
        }

        // 处理输入请求（只在变化时重新渲染）
        const inputRequests = await inputRes.json();
        if (JSON.stringify(inputRequests) !== JSON.stringify(window.lastInputRequests || [])) {
          window.lastInputRequests = inputRequests;
          renderInputRequests(inputRequests);
          updateRollbackActionVisibility();
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

        if (activeFeaturePanel) {
          if (activeFeaturePanel === 'logs') {
            await loadLogs();
          } else {
            const hooksRes = await fetch(\`/api/agents/\${currentAgentId}/hooks\`);
            const nextHookInspector = normalizeHookInspector(await hooksRes.json());
            const nextSignature = getHookInspectorSignature(nextHookInspector);
            if (nextSignature !== currentHookInspectorSignature) {
              currentHookInspector = nextHookInspector;
              currentHookInspectorSignature = nextSignature;
              renderFeaturePanel();
            } else if (activeFeaturePanel === 'inspector') {
              renderFeaturePanel();
            }
          }
        }

      } catch (e) {
        setConnectionStatus(false);
      }
      setTimeout(poll, 100);
    }
`;
