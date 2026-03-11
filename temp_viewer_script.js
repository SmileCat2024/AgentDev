    // Feature 模板映射（从 API 动态加载）
    let FEATURE_TEMPLATE_MAP = {};

    // 加载 Feature 模板映射
    async function loadFeatureTemplateMap() {
      try {
        const response = await fetch('/api/templates/feature');
        if (response.ok) {
          const data = await response.json();
          if (Object.keys(data).length > 0) {
            FEATURE_TEMPLATE_MAP = data;
            return true;
          }
        }
        return false;
      } catch (e) {
        console.warn('[Viewer] Failed to load feature templates:', e);
        return false;
      }
    }

    // 重新加载 Feature 模板映射
    async function reloadFeatureTemplateMap() {
      console.log('[Viewer] Reloading feature templates...');
      const success = await loadFeatureTemplateMap();
      if (success) {
        // 重新加载当前页面的工具配置
        if (currentAgentId) {
          await loadAgentTools(currentAgentId);
          // 重新渲染当前消息
          if (currentMessages.length > 0) {
            render(currentMessages);
          }
        }
      }
    }

    const container = document.getElementById('chat-container');
    const statusBadge = document.getElementById('connection-status');
    const agentList = document.getElementById('agent-list');
    const currentAgentTitle = document.getElementById('current-agent-name');
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const featurePanel = document.getElementById('feature-panel');
    const featurePanelTitle = document.getElementById('feature-panel-title');
    const featurePanelBody = document.getElementById('feature-panel-body');
    const featurePanelResizer = document.getElementById('feature-panel-resizer');
    const agentContextMenu = document.getElementById('agent-context-menu');
    const deleteAgentAction = document.getElementById('delete-agent-action');
    const railButtons = Array.from(document.querySelectorAll('.rail-button'));
    const languageToggle = document.getElementById('language-toggle');
    const themeToggle = document.getElementById('theme-toggle');

    let currentAgentId = null;
    let allAgents = [];
    let currentMessages = [];
    let toolRenderConfigs = {};
    let TOOL_NAMES = {};
    let contextMenuAgentId = null;
    let activeFeaturePanel = null;
    let featurePanelWidth = 320;
    let currentTheme = localStorage.getItem('agentdev-theme') || 'dark';
    let currentLanguage = localStorage.getItem('agentdev-language') || 'zh';
    let currentHookInspector = { lifecycleOrder: [], features: [], hooks: [] };
    let currentHookInspectorSignature = '';
    let selectedOverviewLifecycle = 'StepFinish';
    let selectedFeatureName = null;

    const I18N = {
      zh: {
        page_title: 'Agent 调试器',
        sidebar_toggle: '切换侧栏',
        resize_panel: '调整面板宽度',
        chars: '字符',
        status_connected: '已连接',
        status_disconnected: '已断开',
        status_no_agent: '无 Agent',
        empty_waiting: '等待消息中...',
        panel_hint: '选择右侧功能按钮以展开面板。',
        panel_overview: '总览',
        panel_features: 'Features',
        panel_reverse_hooks: 'Reverse Hooks',
        panel_loop_flow: 'Loop Flow',
        panel_select_lifecycle: '选择一个生命周期阶段',
        panel_inspector: 'Inspector',
        panel_connection: '连接状态',
        panel_messages: '消息数',
        panel_features_label: 'Features',
        panel_enabled: '启用中',
        panel_total: '总数',
        panel_all_features: '全部 Features',
        panel_registered: '已注册',
        panel_no_features: '没有 Feature',
        panel_no_feature_data: '当前 Agent 尚未上报 feature 信息。',
        panel_feature_details: 'Feature 详情',
        panel_loaded_tools: '已加载工具',
        panel_no_tools: '当前没有已注册工具。',
        panel_close: '关闭',
        panel_no_hook_data: '没有 Hook 数据',
        panel_no_hook_data_desc: '当前 Agent 尚未上报 feature / hook 监视信息。',
        panel_all_lifecycle_slots: '完整 8 个生命周期槽位',
        panel_attached: '已挂载',
        panel_no_handlers: '当前没有挂载任何处理函数。',
        stat_active_agent: '当前 Agent',
        stat_hook_slots: 'Hook 已占用',
        stat_decision_points: '决策点',
        feature_source_missing: '暂无源码信息',
        feature_enabled: 'enabled',
        feature_partial: 'partial',
        feature_hooks: 'hooks',
        feature_tools: 'tools',
        feature_messages: '条消息',
        feature_registered_label: '已注册',
        feature_active_tools: '启用工具',
        feature_tool_enabled: 'enabled',
        feature_tool_disabled: 'disabled',
        feature_tool_render: 'render',
        feature_open_details: '查看详情',
        active_none: '无',
        delete_agent: '删除 Agent',
        delete_confirm: '删除这个已断开的 Agent？这只会从当前调试界面移除它的记录。',
        delete_failed: '删除 Agent 失败: ',
        theme_toggle_light: '切换到浅色模式',
        theme_toggle_dark: '切换到深色模式',
        language_toggle: '切换到英文',
        language_toggle_short: 'EN',
        workspace_tooltip: '总览',
        features_tooltip: 'Features',
        reverse_hooks_tooltip: 'Reverse Hooks',
        phase_thinking: '思考中',
        phase_content: '生成内容',
        phase_tool_calling: '工具调用',
        input_placeholder: '正在与 Agent 对话',
        expand: '展开',
        collapse: '收起',
        thinking_process: '思考过程',
        hook_kind: 'hook',
        subagent: '子代理',
        subagent_done: '已完成',
        subagent_view_messages: '查看消息 >',
        delete_failed_generic: '删除失败',
        overview_subtitle: '查看当前 agent 的 hook 映射、循环阶段说明以及用于阅读会话链路的开发者视角解释。',
      },
      en: {
        page_title: 'Agent Debugger',
        sidebar_toggle: 'Toggle Sidebar',
        resize_panel: 'Resize panel',
        chars: 'chars',
        status_connected: 'Connected',
        status_disconnected: 'Disconnected',
        status_no_agent: 'No agent',
        empty_waiting: 'Waiting for messages...',
        panel_hint: 'Select a tool on the right rail to open the panel.',
        panel_overview: 'Overview',
        panel_features: 'Features',
        panel_reverse_hooks: 'Reverse Hooks',
        panel_loop_flow: 'Loop Flow',
        panel_select_lifecycle: 'Select a lifecycle stage',
        panel_inspector: 'Inspector',
        panel_connection: 'Connection',
        panel_messages: 'Messages',
        panel_features_label: 'Features',
        panel_enabled: 'enabled',
        panel_total: 'total',
        panel_all_features: 'All Features',
        panel_registered: 'registered',
        panel_no_features: 'No Features',
        panel_no_feature_data: 'The current agent has not reported feature metadata yet.',
        panel_feature_details: 'Feature Details',
        panel_loaded_tools: 'Loaded Tools',
        panel_no_tools: 'No tools are currently registered for this feature.',
        panel_close: 'Close',
        panel_no_hook_data: 'No Hook Data',
        panel_no_hook_data_desc: 'The current agent has not reported any feature / hook inspector data yet.',
        panel_all_lifecycle_slots: 'All 8 lifecycle slots',
        panel_attached: 'attached',
        panel_no_handlers: 'No attached handlers.',
        stat_active_agent: 'Active Agent',
        stat_hook_slots: 'Hook Slots Filled',
        stat_decision_points: 'Decision Points',
        feature_source_missing: 'No source metadata',
        feature_enabled: 'enabled',
        feature_partial: 'partial',
        feature_hooks: 'hooks',
        feature_tools: 'tools',
        feature_messages: 'messages',
        feature_registered_label: 'registered',
        feature_active_tools: 'Active Tools',
        feature_tool_enabled: 'enabled',
        feature_tool_disabled: 'disabled',
        feature_tool_render: 'render',
        feature_open_details: 'Open details',
        active_none: 'None',
        delete_agent: 'Delete Agent',
        delete_confirm: 'Delete this disconnected agent? This only removes it from the current debugger view.',
        delete_failed: 'Failed to delete agent: ',
        theme_toggle_light: 'Switch to light mode',
        theme_toggle_dark: 'Switch to dark mode',
        language_toggle: 'Switch to Chinese',
        language_toggle_short: '中',
        workspace_tooltip: 'Overview',
        features_tooltip: 'Features',
        reverse_hooks_tooltip: 'Reverse Hooks',
        phase_thinking: 'Thinking',
        phase_content: 'Streaming',
        phase_tool_calling: 'Tool Calling',
        input_placeholder: 'Chatting with the agent',
        expand: 'Expand',
        collapse: 'Collapse',
        thinking_process: 'Thinking Process',
        hook_kind: 'hook',
        subagent: 'SubAgent',
        subagent_done: 'Completed',
        subagent_view_messages: 'View messages >',
        delete_failed_generic: 'Delete failed',
        overview_subtitle: 'Inspect the current agent hook map, loop timing guide, and developer-facing explanations for reading the session flow.',
      },
    };

    function t(key) {
      const table = I18N[currentLanguage] || I18N.zh;
      return table[key] || key;
    }

    function getEmptyStateHtml() {
      return '<div class="empty-state">' + escapeHtml(t('empty_waiting')) + '</div>';
    }

    function getFeaturePanelEmptyHtml() {
      return '<div class="feature-panel-empty"><div>' + escapeHtml(t('panel_hint')) + '</div></div>';
    }

    function getToggleButtonLabel(collapsed) {
      return collapsed
        ? '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> ' + escapeHtml(t('expand'))
        : '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> ' + escapeHtml(t('collapse'));
    }

    function shortenSourcePath(value) {
      if (!value) return '';
      const normalized = String(value).replace(/\\/g, '/');
      const srcIndex = normalized.lastIndexOf('/src/');
      if (srcIndex >= 0) return normalized.slice(srcIndex + 1);
      const agentdevIndex = normalized.lastIndexOf('/AgentDev/');
      if (agentdevIndex >= 0) return normalized.slice(agentdevIndex + 10);
      return normalized;
    }

    const FULL_HOOK_LIFECYCLE_ORDER = [
      'AgentInitiate',
      'AgentDestroy',
      'CallStart',
      'CallFinish',
      'StepStart',
      'StepFinish',
      'ToolUse',
      'ToolFinished',
    ];

    function getHookInspectorSignature(snapshot) {
      return JSON.stringify(snapshot || { lifecycleOrder: [], features: [], hooks: [] });
    }

    function normalizeHookInspector(snapshot) {
      const raw = snapshot || { lifecycleOrder: [], features: [], hooks: [] };
      const hookMap = new Map((raw.hooks || []).map(group => [group.lifecycle, group]));
      return {
        lifecycleOrder: FULL_HOOK_LIFECYCLE_ORDER.slice(),
        features: (raw.features || []).map(feature => ({
          ...feature,
          tools: feature.tools || [],
        })),
        hooks: FULL_HOOK_LIFECYCLE_ORDER.map((lifecycle) => {
          const existing = hookMap.get(lifecycle);
          if (existing) return existing;
          return {
            lifecycle,
            kind: lifecycle === 'StepFinish' || lifecycle === 'ToolUse' ? 'decision' : 'notify',
            entries: [],
          };
        }),
      };
    }

    function setCurrentHookInspector(snapshot) {
      const normalized = normalizeHookInspector(snapshot);
      currentHookInspector = normalized;
      currentHookInspectorSignature = getHookInspectorSignature(normalized);
      if (selectedFeatureName && !normalized.features.some(feature => feature.name === selectedFeatureName)) {
        selectedFeatureName = null;
      }
    }

    const lifecycleDocs = {
      AgentInitiate: {
        title: { zh: 'Agent 初始化阶段', en: 'Agent initialization phase' },
        body: {
          zh: [
          '这个时机只会在 agent 第一次真正进入工作状态时触发一次，适合做长生命周期资源的准备工作，比如启动后台服务、建立连接、预热缓存，或者把框架级能力挂进运行环境。',
          '',
          '~~~ts',
          '@AgentInitiate',
          'async boot(ctx) {',
          '  await this.indexWorkspace();',
          '  await this.startObserver();',
          '}',
          '~~~',
          '',
          '如果某个 feature 要在整个会话期间维持状态，这里通常是它最稳妥的切入点。相比 CallStart，它不会被每次用户输入重复触发。',
        ].join('\\n'),
          en: [
          'This moment fires only once when the agent truly enters its working state. It is the right place for long-lived setup such as booting background services, opening connections, warming caches, or mounting framework-level helpers.',
          '',
          '~~~ts',
          '@AgentInitiate',
          'async boot(ctx) {',
          '  await this.indexWorkspace();',
          '  await this.startObserver();',
          '}',
          '~~~',
          '',
          'If a feature needs to hold state across the whole session, this is usually the safest insertion point. Unlike CallStart, it is not repeated on every user request.',
        ].join('\\n'),
        },
      },
      AgentDestroy: {
        title: { zh: 'Agent 销毁阶段', en: 'Agent destroy phase' },
        body: { zh: [
          '这是 agent 生命周期的收尾点，用来释放外部资源、停止后台线程、断开连接，以及把调试信息或缓存安全落盘。',
          '',
          '~~~ts',
          '@AgentDestroy',
          'async cleanup() {',
          '  await this.workerPool.stop();',
          '  await this.cache.flush();',
          '}',
          '~~~',
          '',
          '如果一个 feature 在 AgentInitiate 做了重量级初始化，就应该在这里成对地清理掉。',
        ].join('\\n'),
          en: [
          'This is the closing stage of the agent lifecycle. Use it to release external resources, stop workers, close connections, and flush traces or caches safely to disk.',
          '',
          '~~~ts',
          '@AgentDestroy',
          'async cleanup() {',
          '  await this.workerPool.stop();',
          '  await this.cache.flush();',
          '}',
          '~~~',
          '',
          'If a feature performs heavyweight setup in AgentInitiate, it should usually tear that work down here.',
        ].join('\\n') },
      },
      CallStart: {
        title: { zh: 'Call 开始前', en: 'Before call start' },
        body: { zh: [
          '这个时机发生在系统提示词之后、用户输入正式写入上下文之前。它非常适合做输入重写、前置注入和会话级别的轻量整理。',
          '',
          '~~~ts',
          '@CallStart',
          'async rewriteInput(ctx) {',
          '  const raw = ctx.agent?.getUserInput() ?? ctx.input;',
          '  ctx.agent?.setUserInput(raw.trim());',
          '}',
          '~~~',
          '',
          '如果你想观察 feature 如何“提前影响”一次调用，这里通常是最有解释力的节点。',
        ].join('\\n'),
          en: [
          'This timing happens after the system prompt is ready but before the user input is committed into context. It is ideal for input rewriting, pre-injection, and lightweight call-level normalization.',
          '',
          '~~~ts',
          '@CallStart',
          'async rewriteInput(ctx) {',
          '  const raw = ctx.agent?.getUserInput() ?? ctx.input;',
          '  ctx.agent?.setUserInput(raw.trim());',
          '}',
          '~~~',
          '',
          'If you want to explain how a feature affects a call before the model sees it, this is usually the clearest node.',
        ].join('\\n') },
      },
      CallFinish: {
        title: { zh: 'Call 结束后', en: 'After call finish' },
        body: { zh: [
          '这是一次完整调用结束后的结算点。适合做摘要、记录、指标更新、落日志，而不适合决定下一轮 ReAct 要不要继续。',
          '',
          '~~~ts',
          '@CallFinish',
          'async afterCall(ctx) {',
          '  this.metrics.track(ctx.completed, ctx.steps);',
          '}',
          '~~~',
          '',
          '它更像“回合总结”，而不是流程控制点。',
        ].join('\\n'),
          en: [
          'This is the settlement point after a full call completes. It fits summarization, logging, and metrics updates, but it is not the place to decide whether the next ReAct turn should continue.',
          '',
          '~~~ts',
          '@CallFinish',
          'async afterCall(ctx) {',
          '  this.metrics.track(ctx.completed, ctx.steps);',
          '}',
          '~~~',
          '',
          'It behaves more like an end-of-call summary than a flow-control decision point.',
        ].join('\\n') },
      },
      StepStart: {
        title: { zh: 'Step 开始前', en: 'Before step start' },
        body: { zh: [
          '每轮 ReAct 循环刚开始时都会进入这里。适合做上下文补丁、提醒注入、局部状态同步。这类钩子往往会高频出现。',
          '',
          '~~~ts',
          '@StepStart',
          'async injectReminder(ctx) {',
          '  if (this.shouldRemind()) {',
          '    ctx.context.add({ role: "system", content: this.reminder });',
          '  }',
          '}',
          '~~~',
          '',
          '因为它会在每一轮执行，所以调试器里把它单独看出来很重要，否则很难解释某些系统消息为什么总会出现。',
        ].join('\\n'),
          en: [
          'Every ReAct iteration enters here right at the beginning. It is useful for context patching, reminder injection, and local state synchronization. These hooks often run at high frequency.',
          '',
          '~~~ts',
          '@StepStart',
          'async injectReminder(ctx) {',
          '  if (this.shouldRemind()) {',
          '    ctx.context.add({ role: "system", content: this.reminder });',
          '  }',
          '}',
          '~~~',
          '',
          'Because it runs every round, surfacing it clearly in the debugger is important; otherwise it is hard to explain why some system messages keep appearing.',
        ].join('\\n') },
      },
      StepFinish: {
        title: { zh: 'Step 结束决策点', en: 'Step finish decision point' },
        body: { zh: [
          '这是 ReAct 循环里最关键的控制点之一。模型和工具都跑完后，feature 可以在这里决定“继续下一轮”还是“就地结束”。',
          '',
          '~~~ts',
          '@StepFinish',
          'async decide(ctx) {',
          '  if (this.hasPendingDelegates()) {',
          '    return Decision.Approve;',
          '  }',
          '  return Decision.Continue;',
          '}',
          '~~~',
          '',
          '如果某个 feature 能把 agent 的循环强行维持住，通常就是在这里介入。它解释的是“为什么这轮已经看起来结束了，但系统还在继续跑”。',
        ].join('\\n'),
          en: [
          'This is one of the most important control points in the ReAct loop. After the model and tools finish, a feature can decide whether the loop should continue or end right away.',
          '',
          '~~~ts',
          '@StepFinish',
          'async decide(ctx) {',
          '  if (this.hasPendingDelegates()) {',
          '    return Decision.Approve;',
          '  }',
          '  return Decision.Continue;',
          '}',
          '~~~',
          '',
          'If a feature can keep the agent alive beyond what looks like a natural stopping point, it is usually intervening here.',
        ].join('\\n') },
      },
      ToolUse: {
        title: { zh: '工具执行前决策点', en: 'Before tool execution decision point' },
        body: { zh: [
          '这是另一个高价值观察位点。工具真正执行前，feature 可以在这里批准、拒绝或者放行。所有安全策略、危险操作拦截都很适合在这里实现。',
          '',
          '~~~ts',
          '@ToolUse',
          'async guard(ctx) {',
          '  if (ctx.call.name === "run_shell_command") {',
          '    return Decision.Deny;',
          '  }',
          '  return Decision.Continue;',
          '}',
          '~~~',
          '',
          '调试器里只要看清楚这里挂了谁，很多“为什么工具没执行”或者“为什么执行路径被改写”就能直接定位。',
        ].join('\\n'),
          en: [
          'This is another high-value inspection point. Before a tool actually runs, a feature can approve, deny, or pass it through. Security policy and dangerous-operation guards fit naturally here.',
          '',
          '~~~ts',
          '@ToolUse',
          'async guard(ctx) {',
          '  if (ctx.call.name === "run_shell_command") {',
          '    return Decision.Deny;',
          '  }',
          '  return Decision.Continue;',
          '}',
          '~~~',
          '',
          'As soon as you can see who is attached here, many "why did the tool not run?" questions become much easier to answer.',
        ].join('\\n') },
      },
      ToolFinished: {
        title: { zh: '工具执行后通知点', en: 'After tool finished notify point' },
        body: { zh: [
          '工具已经返回结果以后，这里会收到纯通知。适合做后处理、索引、同步外部状态、记录审计信息，但不会改变刚刚那次工具调用本身的结果。',
          '',
          '~~~ts',
          '@ToolFinished',
          'async record(ctx) {',
          '  this.auditTrail.push({',
          '    tool: ctx.toolName,',
          '    duration: ctx.duration,',
          '  });',
          '}',
          '~~~',
          '',
          '这类钩子更偏“旁路观察”和“后续整理”，所以通常适合完整展开给开发者查链路。',
        ].join('\\n'),
          en: [
          'Once a tool returns its result, this point receives a pure notification. It suits post-processing, indexing, external state sync, and audit recording, but it does not change the result of the tool call that already happened.',
          '',
          '~~~ts',
          '@ToolFinished',
          'async record(ctx) {',
          '  this.auditTrail.push({',
          '    tool: ctx.toolName,',
          '    duration: ctx.duration,',
          '  });',
          '}',
          '~~~',
          '',
          'These hooks are more about side-channel observation and cleanup, so they are usually worth showing in full detail to developers.',
        ].join('\\n') },
      },
    };

    function selectOverviewLifecycle(lifecycle) {
      selectedOverviewLifecycle = lifecycle;
      if (activeFeaturePanel === 'workspace') {
        renderFeaturePanel();
      }
    }

    window.selectOverviewLifecycle = selectOverviewLifecycle;

    function openFeatureDetails(featureName) {
      selectedFeatureName = featureName;
      if (activeFeaturePanel === 'hooks') {
        renderFeaturePanel();
      }
    }

    function closeFeatureDetails() {
      selectedFeatureName = null;
      if (activeFeaturePanel === 'hooks') {
        renderFeaturePanel();
      }
    }

    window.openFeatureDetails = openFeatureDetails;
    window.closeFeatureDetails = closeFeatureDetails;

    function renderOverviewPanel() {
      const hookIcons = {
        AgentInitiate: 'A',
        AgentDestroy: 'D',
        CallStart: 'C',
        CallFinish: 'C',
        StepStart: 'S',
        StepFinish: 'R',
        ToolUse: 'T',
        ToolFinished: 'F',
      };
      const activeAgent = allAgents.find(agent => agent.id === currentAgentId);
      const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
      const totalHooks = currentHookInspector.hooks.reduce((sum, group) => sum + group.entries.length, 0);
      const decisionHooks = currentHookInspector.hooks.reduce(
        (sum, group) => sum + group.entries.filter(entry => entry.kind === 'decision').length,
        0
      );
      const selectedDoc = lifecycleDocs[selectedOverviewLifecycle] || lifecycleDocs.StepFinish;
      const flowChips = currentHookInspector.lifecycleOrder
        .map(name => '<button class="hooks-chip' + (name === selectedOverviewLifecycle ? ' active' : '') + '" type="button" onclick="window.selectOverviewLifecycle(&quot;' + escapeHtml(name) + '&quot;)"><strong>' + escapeHtml(name) + '</strong></button>')
        .join('');
      return [
        '<div class="hooks-panel">',
        '<section class="hooks-hero">',
        '<div class="hooks-kicker">React Loop Topology</div>',
        '<div class="hooks-hero-title">Feature Hooks Map</div>',
        '<div class="hooks-hero-subtitle">' + escapeHtml(t('overview_subtitle')) + '</div>',
        '<div class="hooks-stats">',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(activeAgent ? activeAgent.name : t('active_none')) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_hook_slots')) + '</div><div class="hooks-stat-value">' + String(totalHooks) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_decision_points')) + '</div><div class="hooks-stat-value">' + String(decisionHooks) + '</div></div>',
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_inspector')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
        '<div class="feature-grid">',
        '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_connection')) + '</div><div class="feature-card-detail"><span>' + escapeHtml(connected) + '</span><span>' + String(currentMessages.length) + ' ' + escapeHtml(t('feature_messages')) + '</span></div></div>',
        '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_features_label')) + '</div><div class="feature-card-detail"><span>' + String(currentHookInspector.features.filter(feature => feature.enabled).length) + ' ' + escapeHtml(t('panel_enabled')) + '</span><span>' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_total')) + '</span></div></div>',
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_loop_flow')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_select_lifecycle')) + '</div></div>',
        '<div class="hooks-strip">' + flowChips + '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(selectedOverviewLifecycle) + '</div><div class="hooks-section-meta">' + escapeHtml(selectedDoc.title[currentLanguage] || selectedDoc.title.zh) + '</div></div>',
        '<div class="feature-panel-section overview-doc"><div class="markdown-body">' + marked.parse(selectedDoc.body[currentLanguage] || selectedDoc.body.zh) + '</div></div>',
        '</section>',
        '</div>',
      ].join('');
    }

    function renderFeaturesPanel() {
      if (currentHookInspector.features.length === 0) {
        return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_features')) + '</div><div>' + escapeHtml(t('panel_no_feature_data')) + '</div></div></div>';
      }

      const selectedFeature = currentHookInspector.features.find(feature => feature.name === selectedFeatureName) || null;
      const featureCards = currentHookInspector.features
        .map(feature => [
          '<div class="feature-card" role="button" tabindex="0" onclick="window.openFeatureDetails(&quot;' + escapeHtml(feature.name) + '&quot;)" title="' + escapeHtml(t('feature_open_details')) + '">',
          '<div class="feature-card-top">',
          '<div class="feature-card-main">',
          '<span class="feature-card-dot"></span>',
          '<div style="min-width:0;">',
          '<div class="feature-card-name">' + escapeHtml(feature.name) + '</div>',
          '<div class="feature-card-file">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + '</div>',
          '</div>',
          '</div>',
          '<div class="feature-badge">' + escapeHtml(feature.enabled ? t('feature_enabled') : t('feature_partial')) + '</div>',
          '</div>',
          '<div class="feature-card-detail">',
          '<span>' + String(feature.hookCount) + ' ' + escapeHtml(t('feature_hooks')) + '</span>',
          '<span>' + String(feature.enabledToolCount) + '/' + String(feature.toolCount) + ' ' + escapeHtml(t('feature_tools')) + '</span>',
          feature.description ? '<span>' + escapeHtml(feature.description) + '</span>' : '',
          '</div>',
          '</div>',
        ].join(''))
        .join('');

      const detailOverlay = selectedFeature ? [
        '<div class="feature-detail-overlay" onclick="if (event.target === this) window.closeFeatureDetails()">',
        '<div class="feature-detail-window">',
        '<div class="feature-detail-head">',
        '<div>',
        '<div class="feature-detail-title">' + escapeHtml(selectedFeature.name) + '</div>',
        '<div class="feature-detail-subtitle">' + escapeHtml(selectedFeature.description || '') + '</div>',
        '</div>',
        '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="window.closeFeatureDetails()">×</button>',
        '</div>',
        '<div class="feature-detail-stats">',
        '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_hooks')) + '</div><div class="feature-detail-stat-value">' + String(selectedFeature.hookCount) + '</div></div>',
        '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_active_tools')) + '</div><div class="feature-detail-stat-value">' + String(selectedFeature.enabledToolCount) + '/' + String(selectedFeature.toolCount) + '</div></div>',
        '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('panel_connection')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(selectedFeature.enabled ? t('feature_enabled') : t('feature_partial')) + '</div></div>',
        '</div>',
        '<div class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('panel_feature_details')) + '</div>',
        '<div class="feature-detail-subtitle">' + escapeHtml(shortenSourcePath(selectedFeature.source) || t('feature_source_missing')) + '</div>',
        '</div>',
        '<div class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('panel_loaded_tools')) + '</div>',
        selectedFeature.tools && selectedFeature.tools.length > 0
          ? '<div class="feature-tool-list">' + selectedFeature.tools.map(tool => [
              '<div class="feature-tool-card">',
              '<div class="feature-tool-top">',
              '<div class="feature-tool-name">' + escapeHtml(tool.name) + '</div>',
              '<div class="feature-badge">' + escapeHtml(tool.enabled ? t('feature_tool_enabled') : t('feature_tool_disabled')) + '</div>',
              '</div>',
              '<div class="feature-tool-desc">' + escapeHtml(tool.description || '') + '</div>',
              '<div class="feature-tool-meta">',
              tool.renderCall ? '<span class="feature-tool-pill">' + escapeHtml(t('feature_tool_render')) + ': call/' + escapeHtml(tool.renderCall) + '</span>' : '',
              tool.renderResult ? '<span class="feature-tool-pill">' + escapeHtml(t('feature_tool_render')) + ': result/' + escapeHtml(tool.renderResult) + '</span>' : '',
              '</div>',
              '</div>',
            ].join('')).join('') + '</div>'
          : '<div class="feature-detail-subtitle">' + escapeHtml(t('panel_no_tools')) + '</div>',
        '</div>',
        '</div>',
        '</div>',
      ].join('') : '';

      return [
        '<div class="hooks-panel">',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_all_features')) + '</div><div class="hooks-section-meta">' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_registered')) + '</div></div>',
        '<div class="feature-detail-shell"><div class="feature-grid">' + featureCards + '</div>' + detailOverlay + '</div>',
        '</section>',
        '</div>',
      ].join('');
    }

    function renderReverseHooksPanel() {
      const hookIcons = {
        AgentInitiate: 'A',
        AgentDestroy: 'D',
        CallStart: 'C',
        CallFinish: 'C',
        StepStart: 'S',
        StepFinish: 'R',
        ToolUse: 'T',
        ToolFinished: 'F',
      };

      const lifecycleCards = currentHookInspector.hooks
        .map(group => {
          const entriesHtml = group.entries.map((entry, index) => [
            '<div class="hook-step">',
            '<div class="hook-step-order">' + String(index + 1) + '</div>',
            '<div class="hook-step-card">',
            '<div class="hook-step-row">',
            '<div class="hook-step-feature">' + escapeHtml(entry.featureName) + '</div>',
            '<div class="hook-step-kind">' + escapeHtml(entry.kind) + '</div>',
            '</div>',
            '<div class="hook-step-method">' + escapeHtml(entry.methodName) + '()</div>',
            entry.source && entry.source.display ? '<div class="hook-step-location">' + escapeHtml(shortenSourcePath(entry.source.display)) + '</div>' : '',
            entry.description ? '<div class="hook-step-notes">' + escapeHtml(entry.description) + '</div>' : '',
            '</div>',
            '</div>',
          ].join('')).join('');

          return [
            '<section class="hook-lifecycle-card">',
            '<div class="hook-lifecycle-head">',
          '<div class="hook-lifecycle-name">',
          '<span class="hook-lifecycle-icon">' + escapeHtml(hookIcons[group.lifecycle] || 'H') + '</span>',
          '<div>',
          '<div>' + escapeHtml(group.lifecycle) + '</div>',
          '<div class="hook-lifecycle-type">' + escapeHtml(group.kind) + ' ' + escapeHtml(t('hook_kind')) + '</div>',
          '</div>',
          '</div>',
            '<div style="display:flex;align-items:center;gap:12px;">',
            '<div class="hooks-section-meta">' + String(group.entries.length) + ' ' + escapeHtml(t('panel_attached')) + '</div>',
            '</div>',
            '</div>',
            '<div class="hook-call-chain">',
            entriesHtml || '<div class="hooks-section-meta">' + escapeHtml(t('panel_no_handlers')) + '</div>',
            '</div>',
            '</section>',
          ].join('');
        })
        .join('');

      if (currentHookInspector.hooks.length === 0) {
        return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_hook_data')) + '</div><div>' + escapeHtml(t('panel_no_hook_data_desc')) + '</div></div></div>';
      }

      return [
        '<div class="hooks-panel">',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_reverse_hooks')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_all_lifecycle_slots')) + '</div></div>',
        '<div class="hook-lifecycle-list">' + lifecycleCards + '</div>',
        '</section>',
        '</div>',
      ].join('');
    }

    const featurePanels = {
      workspace: {
        title: () => t('panel_overview'),
        render: () => renderOverviewPanel(),
      },
      hooks: {
        title: () => t('panel_features'),
        render: () => renderFeaturesPanel(),
      },
      inspector: {
        title: () => t('panel_reverse_hooks'),
        render: () => renderReverseHooksPanel(),
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
      const hooksButton = document.getElementById('rail-hooks');
      const inspectorButton = document.getElementById('rail-inspector');

      if (sidebarToggleEl) sidebarToggleEl.title = t('sidebar_toggle');
      if (panelResizerEl) panelResizerEl.title = t('resize_panel');
      if (notificationCharLabel) notificationCharLabel.textContent = t('chars');
      if (workspaceButton) workspaceButton.title = t('workspace_tooltip');
      if (hooksButton) hooksButton.title = t('features_tooltip');
      if (inspectorButton) inspectorButton.title = t('reverse_hooks_tooltip');

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
      if (!activeFeaturePanel || !featurePanels[activeFeaturePanel]) {
        featurePanel.classList.remove('open');
        featurePanelTitle.textContent = t('panel_overview');
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
    }

    function toggleFeaturePanel(panelId) {
      activeFeaturePanel = activeFeaturePanel === panelId ? null : panelId;
      renderFeaturePanel();
    }

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

    /**
     * 根据模板名解析文件路径
     * 优先级：Feature 模板 > 系统模板 > 兜底
     */
    const self = this;

    // 系统默认模板映射（兜底）
    const SYSTEM_TEMPLATE_MAP = {
      'agent-spawn': 'system/subagent',
      'agent-list': 'system/subagent',
      'agent-send': 'system/subagent',
      'agent-close': 'system/subagent',
      'wait': 'system/subagent',
      'file-read': 'system/fs',
      'file-write': 'system/fs',
      'file-list': 'system/fs',
      'skill': 'system/skill',
      'invoke_skill': 'system/skill',
      'command': 'system/shell',
      'bash': 'system/shell',
      'shell': 'system/shell',
      'web': 'system/web',
      'fetch': 'system/web',
      'math': 'system/math',
      'calculator': 'system/math',
      'read': 'opencode/read',
      'write': 'opencode/write',
      'edit': 'opencode/edit',
      'ls': 'opencode/ls',
      'glob': 'opencode/glob',
      'grep': 'opencode/grep',
    };

    function resolveTemplatePath(templateName) {
      // 1. 优先查找 Feature 模板（从后端注入的动态数据）
      if (FEATURE_TEMPLATE_MAP[templateName]) {
        return FEATURE_TEMPLATE_MAP[templateName];
      }

      // 2. 使用系统默认映射
      if (SYSTEM_TEMPLATE_MAP[templateName]) {
        return '/tools/' + SYSTEM_TEMPLATE_MAP[templateName] + '.render.js';
      }

      // 3. 兜底：按约定查找 opencode
      return '/tools/opencode/' + templateName + '.render.js';
    }

    /**
     * 异步加载模板
     * 支持从 Feature 目录或系统目录加载
     * 如果加载失败，回退到内置模板
     */
    async function loadTemplate(templateName) {
      if (templateCache.has(templateName)) {
        return templateCache.get(templateName);
      }

      try {
        const path = resolveTemplatePath(templateName);

        // 统一使用 URL 方式加载模板
        // Feature 模板: /features/shell/trash-delete.render.js
        // 系统模板: /tools/system/shell.render.js
        const module = await import(path);

        // 1. 优先使用 default export（Feature 模板）
        let template = module.default;
        if (template) {
          templateCache.set(templateName, template);
          return template;
        }

        // 2. 尝试从 TEMPLATES 对象获取（系统模板）
        if (module.TEMPLATES && module.TEMPLATES[templateName]) {
          template = module.TEMPLATES[templateName];
          templateCache.set(templateName, template);
          return template;
        }

        console.warn('[Viewer Worker] 模板 "' + templateName + '" 在文件中未找到');
        return null;
      } catch (e) {
        console.warn('[Viewer Worker] 加载模板失败: ' + templateName, e);
        return null;
      }
    }

    function getToolRenderTemplate(toolName) {
      const config = toolRenderConfigs[toolName];
      const callTemplateName = (config?.render?.call) || 'json';
      const resultTemplateName = (config?.render?.result) || 'json';

      const callIsInline = callTemplateName === '__inline__';
      const resultIsInline = resultTemplateName === '__inline__';

      let callTemplate, resultTemplate;

      if (callIsInline) {
        callTemplate = config?.render?.inlineCall;
      } else {
        // 优先从缓存读取
        const cached = templateCache.get(callTemplateName);
        callTemplate = cached?.call || RENDER_TEMPLATES['json'].call;
      }

      if (resultIsInline) {
        resultTemplate = config?.render?.inlineResult;
      } else {
        const cached = templateCache.get(resultTemplateName);
        resultTemplate = cached?.result || RENDER_TEMPLATES['json'].result;
      }

      return {
        call: callTemplate,
        result: resultTemplate,
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
        renderFeaturePanel();

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
          setCurrentHookInspector({ lifecycleOrder: [], features: [], hooks: [] });
          container.innerHTML = getEmptyStateHtml();
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

    async function loadAgentData(agentId) {
      try {
        const [msgsRes, toolsRes, hooksRes] = await Promise.all([
          fetch(\`/api/agents/\${agentId}/messages\`),
          fetch(\`/api/agents/\${agentId}/tools\`),
          fetch(\`/api/agents/\${agentId}/hooks\`)
        ]);

        const msgsData = await msgsRes.json();
        const tools = await toolsRes.json();
        setCurrentHookInspector(await hooksRes.json());

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
          setTimeout(poll, 1000);
          return;
        }

        // 并行请求消息、通知和输入请求
        const [msgsRes, notifRes, connectionRes, inputRes] = await Promise.all([
          fetch(\`/api/agents/\${currentAgentId}/messages\`),
          fetch(\`/api/agents/\${currentAgentId}/notification\`),
          fetch(\`/api/agents/\${currentAgentId}/connection\`),
          fetch(\`/api/agents/\${currentAgentId}/input-requests\`),
        ]);

        const connectionData = await connectionRes.json();
        setConnectionStatus(!!connectionData.connected);

        const data = await msgsRes.json();
        const messages = data.messages || [];

        // 处理通知状态
        const notifData = await notifRes.json();
        updateNotificationStatus(notifData);

        // 处理输入请求（只在变化时重新渲染）
        const inputRequests = await inputRes.json();
        if (JSON.stringify(inputRequests) !== JSON.stringify(window.lastInputRequests || [])) {
          window.lastInputRequests = inputRequests;
          renderInputRequests(inputRequests);
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

      } catch (e) {
        setConnectionStatus(false);
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
          'thinking': t('phase_thinking'),
          'content': t('phase_content'),
          'tool_calling': t('phase_tool_calling')
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

    // 渲染输入请求
    function renderInputRequests(requests) {
      const container = document.getElementById('user-input-container');
      if (!container) return;

      // 清空现有内容
      container.innerHTML = '';

      for (const req of requests) {
        const card = document.createElement('div');
        card.className = 'user-input-card';
        // 极简设计：只有 Textarea
        card.innerHTML = \`
          <textarea class="user-input-textarea" rows="1" id="input-\${req.requestId}"
            onkeydown="handleInputKey(event, '\${req.requestId}')"
            oninput="autoResize(this)"
            placeholder="\${escapeHtml(t('input_placeholder'))}"></textarea>
        \`;
        container.appendChild(card);
        
        // Auto-focus
        setTimeout(() => {
          const el = document.getElementById(\`input-\${req.requestId}\`);
          if(el) {
             el.focus();
             autoResize(el);
          }
        }, 50);
      }
    }

    function autoResize(textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }

    function handleInputKey(event, requestId) {
      if (event.key === 'Enter') {
        if (event.ctrlKey || event.shiftKey) {
          // Ctrl+Enter or Shift+Enter for new line
          // default behavior is new line, but we might want to ensure it works
          return; 
        } else {
          // Enter for submit
          event.preventDefault();
          submitInput(requestId);
        }
      }
    }

    // 提交输入
    async function submitInput(requestId) {
      const textarea = document.getElementById(\`input-\${requestId}\`);
      const input = textarea ? textarea.value : '';

      try {
        const res = await fetch(\`/api/agents/\${currentAgentId}/input\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, input })
        });
        if (res.ok) {
          // 刷新输入请求列表
          poll();
        }
      } catch (e) {
        console.error('提交输入失败:', e);
      }
    }

    // 生成单条消息的 HTML
    function renderMessage(msg, index) {
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
           contentHtml = \`<div class="message-content markdown-body" id="\${msgId}" style="\${style}">\${marked.parse(msg.content)}</div>\`;
        } else {
          contentHtml = \`<div class="message-content markdown-body" id="\${msgId}">\${marked.parse(msg.content)}</div>\`;
        }

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
        return \`
          <div class="message-row \${role}">
            <div class="message-meta">
              \${metaHtml}
            </div>
            \${contentHtml}
          </div>
        \`;
      } else if (role === 'assistant') {
        let innerContent = '';

        if (msg.reasoning) {
          innerContent += \`
            <div class="reasoning-block" id="reasoning-\${msgId}">
                <div class="reasoning-header" onclick="toggleReasoning('reasoning-\${msgId}')">
                  <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
                <span>\${escapeHtml(t('thinking_process'))}</span>
              </div>
              <div class="reasoning-content markdown-body">
                \${marked.parse(msg.reasoning)}
              </div>
            </div>
          \`;
        }

        // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
        const agentCompletePattern = /^[\\s\\S]*\\[子代理\\s+(\\S+)\\s+执行完成\\]:[\\s\\S]*$/;
        const agentCompleteMatch = msg.content.match(agentCompletePattern);
        if (agentCompleteMatch) {
          const agentName = agentCompleteMatch[1];
          // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
          const subAgent = allAgents.find(a => a.name === agentName);
          const subAgentId = subAgent ? subAgent.id : null;
          const clickAttr = subAgentId ? \`onclick="switchAgent('\${subAgentId}')"\` : '';
          const linkHtml = subAgentId
            ? \`<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" \${clickAttr}>\${escapeHtml(t('subagent_view_messages'))}</div>\`
            : '';

          innerContent += \`
              <div class="tool-call-container">
                <div class="tool-header">
                  <span class="tool-header-name">\${escapeHtml(t('subagent_done'))}</span>
                </div>
                <div class="tool-content">
                  <div class="bash-command">【\${escapeHtml(agentName)}】\${escapeHtml(t('subagent_done'))}</div>
                  \${linkHtml}
                </div>
              </div>
          \`;
        } else {
          innerContent += \`<div class="markdown-body">\${marked.parse(msg.content)}</div>\`;
        }

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

        // 查找对应的工具调用（需要传入完整消息列表）
        return '';  // 这个需要在完整上下文中处理，暂时返回空
      }

      return \`
        <div class="message-row \${role}">
          <div class="message-meta">
            \${metaHtml}
          </div>
          \${contentHtml}
        </div>
      \`;
    }

    // 追加新消息（保持现有 DOM 状态）
    function appendNewMessages(newMessages, startIndex) {
      // 移除空状态
      const emptyState = container.querySelector('.empty-state');
      if (emptyState) emptyState.remove();

      // 获取当前消息数量
      const currentCount = container.querySelectorAll('.message-row').length;

      newMessages.forEach((msg, i) => {
        const index = startIndex + i;
        const msgId = \`msg-\${index}\`;
        let html = '';

        if (msg.role === 'user' || msg.role === 'system' || msg.role === 'assistant') {
          html = renderMessage(msg, index);
        } else if (msg.role === 'tool') {
          // tool 需要特殊处理，查找对应的 toolCall
          let toolName = null;
          let toolArgs = {};
          const messages = currentMessages;
          const toolCallId = msg.toolCallId;

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

          html = \`
            <div class="message-row \${msg.role}">
              <div class="message-meta">
                <div class="role-badge">\${msg.role}</div>
              </div>
              <div class="message-content" id="\${msgId}" style="padding:0; overflow:hidden;">
                <div class="tool-result-header">
                  <span class="status-dot \${success ? 'success' : 'error'}"></span>
                  <span>\${displayName}</span>
                </div>
                <div class="tool-result-body">\${bodyHtml}</div>
              </div>
            </div>
          \`;
        }

        // 追加到容器
        container.insertAdjacentHTML('beforeend', html);
      });

      // 对新消息应用折叠逻辑
      applyCollapseLogic(container, startIndex);
    }

    // 更新最后一条消息
    function updateLastMessage(msg) {
      const lastIndex = currentMessages.length - 1;
      const lastRow = container.querySelectorAll('.message-row')[lastIndex];
      if (!lastRow) {
        render(currentMessages);
        return;
      }

      const msgId = \`msg-\${lastIndex}\`;

      if (msg.role === 'tool') {
        // tool 消息更新：重建 tool-result-body
        const toolCallId = msg.toolCallId;
        let toolName = null;
        let toolArgs = {};

        for (const m of currentMessages) {
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

        const toolResultBody = lastRow.querySelector('.tool-result-body');
        if (toolResultBody) {
          toolResultBody.innerHTML = bodyHtml;
        }
      }
    }

    // 应用折叠逻辑（只处理指定索引后的消息）
    function applyCollapseLogic(containerElement, startIndex = 0) {
      const rows = containerElement.querySelectorAll('.message-row');
      rows.forEach((row, idx) => {
        if (idx < startIndex) return;  // 跳过旧消息

        const el = row.querySelector('.message-content');
        if (!el) return;

        const isCollapsible = el.scrollHeight > 160;
        const isSystem = row.classList.contains('system');
        const toolName = row.querySelector('.tool-result-header span:last-child')?.textContent || '';
        const isReadOrEdit = toolName === 'Read' || toolName === 'Edit';
        const shouldCollapse = isCollapsible && (isSystem || isReadOrEdit);

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

           let btnBar = row.querySelector('.expand-toggle-bar');
           if (!btnBar) {
             btnBar = document.createElement('div');
             btnBar.className = 'expand-toggle-bar';
             row.appendChild(btnBar);
           }

           const isCollapsed = el.classList.contains('collapsed');
           btnBar.innerHTML = '<button class="expand-toggle-btn" onclick="toggleMessage(&quot;' + el.id + '&quot;)">' + getToggleButtonLabel(isCollapsed) + '</button>';

        } else {
           const toggle = row.querySelector('.collapse-toggle');
           if (toggle) toggle.style.display = 'none';
        }
      });
    }

    function render(messages) {
      if (messages.length === 0) {
        container.innerHTML = getEmptyStateHtml();
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
             contentHtml = \`<div class="message-content markdown-body" id="\${msgId}" style="\${style}">\${marked.parse(msg.content)}</div>\`;
          } else {
            contentHtml = \`<div class="message-content markdown-body" id="\${msgId}">\${marked.parse(msg.content)}</div>\`;
          }
          
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
                  <span>\${escapeHtml(t('thinking_process'))}</span>
                </div>
                <div class="reasoning-content markdown-body">
                  \${marked.parse(msg.reasoning)}
                </div>
              </div>
            \`;
          }

          // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
          const agentCompletePattern = /^[\\s\\S]*\\[子代理\\s+(\\S+)\\s+执行完成\\]:[\\s\\S]*$/;
          const agentCompleteMatch = msg.content.match(agentCompletePattern);
          if (agentCompleteMatch) {
            const agentName = agentCompleteMatch[1];
            // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
            const subAgent = allAgents.find(a => a.name === agentName);
            const subAgentId = subAgent ? subAgent.id : null;
            const clickAttr = subAgentId ? \`onclick="switchAgent('\${subAgentId}')"\` : '';
            const linkHtml = subAgentId
              ? \`<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" \${clickAttr}>\${escapeHtml(t('subagent_view_messages'))}</div>\`
              : '';

            innerContent += \`
              <div class="tool-call-container">
                <div class="tool-header">
                  <span class="tool-header-name">\${escapeHtml(t('subagent'))}</span>
                </div>
                <div class="tool-content">
                  <div class="bash-command">\${escapeHtml(agentName)} \${escapeHtml(t('subagent_done'))}</div>
                  \${linkHtml}
                </div>
              </div>
            \`;
          } else {
            innerContent += \`<div class="markdown-body">\${marked.parse(msg.content)}</div>\`;
          }

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
        // 检查是否是 read 或 edit 工具
        const toolName = row.querySelector('.tool-result-header span:last-child')?.textContent || '';
        const isReadOrEdit = toolName === 'Read' || toolName === 'Edit';
        const shouldCollapse = isCollapsible && (isSystem || isReadOrEdit);

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
           btnBar.innerHTML = '<button class="expand-toggle-btn" onclick="toggleMessage(&quot;' + el.id + '&quot;)">' + getToggleButtonLabel(isCollapsed) + '</button>';
           
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
          btn.innerHTML = getToggleButtonLabel(isCollapsed);
        }
      }
    };

    window.toggleReasoning = function(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.toggle('expanded');
      }
    };

    // 初始化：先加载 Feature 模板映射，再启动轮询
    // 如果 Feature 模板映射为空（Agent 还未注册），在 loadAgents 后重新加载
    applyTheme(currentTheme);
    applyLanguage();

    loadFeatureTemplateMap().then((success) => {
      loadAgents().then(async () => {
        // 如果第一次加载 Feature 模板失败，重新尝试
        if (!success) {
          console.log('[Viewer] Retrying to load feature templates after agent loaded...');
          await reloadFeatureTemplateMap();
        }
        poll();
      });
    });
