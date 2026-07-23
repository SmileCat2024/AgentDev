export const VIEWER_JS_PANELS = `
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

    function renderStructurePanel() {
      const activeAgent = allAgents.find(agent => agent.id === currentAgentId);
      const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
      const totalHooks = currentHookInspector.hooks.reduce((sum, group) => sum + group.entries.length, 0);
      const decisionHooks = currentHookInspector.hooks.reduce(
        (sum, group) => sum + group.entries.filter(entry => entry.kind === 'decision').length,
        0
      );
      const featureStatusCounts = currentHookInspector.features.reduce((acc, feature) => {
        const status = getFeatureStatus(feature);
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, { enabled: 0, partial: 0, disabled: 0, removed: 0 });
      const selectedDoc = lifecycleDocs[selectedOverviewLifecycle] || lifecycleDocs.StepFinish;
      const flowChips = currentHookInspector.lifecycleOrder
        .map(name => '<button class="hooks-chip' + (name === selectedOverviewLifecycle ? ' active' : '') + '" type="button" onclick="window.selectOverviewLifecycle(&quot;' + escapeHtml(name) + '&quot;)"><strong>' + escapeHtml(name) + '</strong></button>')
        .join('');
      return [
        '<div class="hooks-panel">',
        '<section class="hooks-hero">',
        '<div class="hooks-kicker">' + escapeHtml(t('structure_kicker')) + '</div>',
        '<div class="hooks-hero-title">' + escapeHtml(t('structure_hero_title')) + '</div>',
        '<div class="hooks-hero-subtitle">' + escapeHtml(t('structure_subtitle')) + '</div>',
        '<div class="hooks-stats">',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(activeAgent ? activeAgent.name : t('active_none')) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">Hooks</div><div class="hooks-stat-value">' + String(totalHooks) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">Decision</div><div class="hooks-stat-value">' + String(decisionHooks) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('panel_features_label')) + '</div><div class="hooks-stat-value">' + String(currentHookInspector.features.length) + '</div></div>',
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_inspector')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
        '<div class="feature-grid">',
        '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_connection')) + '</div><div class="feature-card-detail"><span>' + escapeHtml(connected) + '</span><span>' + String(currentMessages.length) + ' ' + escapeHtml(t('feature_messages')) + '</span></div></div>',
        '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_features_label')) + '</div><div class="feature-card-detail"><span>' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_total')) + '</span><span>' + String(featureStatusCounts.enabled) + ' ' + escapeHtml(t('panel_enabled')) + '</span><span>' + String(featureStatusCounts.partial) + ' ' + escapeHtml(t('panel_partial')) + '</span><span>' + String(featureStatusCounts.disabled) + ' ' + escapeHtml(t('panel_disabled')) + '</span><span>' + String(featureStatusCounts.removed) + ' ' + escapeHtml(t('panel_removed')) + '</span></div></div>',
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

    function renderMonitorPanel() {
      const activeAgent = allAgents.find(agent => agent.id === currentAgentId);
      const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
      const overview = currentOverviewSnapshot || getEmptyOverviewSnapshot();
      const totalUsage = overview.usageStats?.totalUsage || {};
      const latestCall = getLatestCallSummary(overview);
      const currentBreakdown = getUsageBreakdown(latestCall, 0);
      const totalBreakdown = getUsageBreakdown({
        totalUsage,
        stepCount: overview.usageStats.totalRequests || 0,
        cacheHitRequests: overview.usageStats.totalCacheHitRequests || 0,
      }, overview.usageStats.totalRequests || 0);
      const contextLengthLabel = formatMetricNumber(overview.context.charCount) + ' chars';
      const latestTurnLabel = latestCall ? formatMetricNumber(currentBreakdown.totalTokens) : t('metric_no_calls');
      return [
        '<div class="hooks-panel">',
        '<section class="hooks-hero">',
        '<div class="hooks-kicker">' + escapeHtml(t('overview_kicker')) + '</div>',
        '<div class="hooks-hero-title">' + escapeHtml(t('overview_hero_title')) + '</div>',
        '<div class="hooks-hero-subtitle">' + escapeHtml(t('overview_subtitle')) + '</div>',
        '<div class="hooks-stats">',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(activeAgent ? activeAgent.name : t('active_none')) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_context_length')) + '</div><div class="hooks-stat-value">' + escapeHtml(contextLengthLabel) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_turn_tokens')) + '</div><div class="hooks-stat-value">' + escapeHtml(latestTurnLabel) + '</div></div>',
        '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_cache_hit_rate')) + '</div><div class="hooks-stat-value">' + escapeHtml(totalBreakdown.cacheHitRate) + '</div></div>',
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_runtime')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
        '<div class="overview-usage-grid">',
        renderUsageCard(t('panel_current_turn'), latestCall ? t('metric_latest_turn') : t('metric_no_calls'), currentBreakdown),
        renderCacheCard(t('panel_current_turn'), currentBreakdown),
        renderUsageCard(t('panel_session_total'), t('metric_session_total'), totalBreakdown),
        renderCacheCard(t('panel_session_total'), totalBreakdown),
        '</div>',
        '</section>',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_context')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_connection')) + ': ' + escapeHtml(connected) + '</div></div>',
        '<div class="context-chip-grid">',
        renderContextChip(t('metric_messages'), formatMetricNumber(overview.context.messageCount), t('panel_context')),
        renderContextChip(t('metric_chars'), formatMetricNumber(overview.context.charCount), t('stat_context_length')),
        renderContextChip(t('metric_turns'), formatMetricNumber(overview.context.turnCount), t('metric_session_total')),
        renderContextChip(t('metric_tool_calls'), formatMetricNumber(overview.context.toolCallCount), t('metric_latest_turn')),
        '</div>',
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
        .map(feature => {
          const status = getFeatureStatus(feature);
          return [
          '<div class="feature-card" role="button" tabindex="0" onclick="window.openFeatureDetails(&quot;' + escapeHtml(feature.name) + '&quot;)" title="' + escapeHtml(t('feature_open_details')) + '">',
          '<div class="feature-card-top">',
          '<div class="feature-card-main">',
          '<span class="feature-card-dot"></span>',
          '<div style="min-width:0;">',
          '<div class="feature-card-name">' + escapeHtml(feature.name) + '</div>',
          '<div class="feature-card-file">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + '</div>',
          '</div>',
          '</div>',
          '<div class="' + getStatusBadgeClass(status) + '">' + escapeHtml(getFeatureStatusLabel(status)) + '</div>',
          '</div>',
          '<div class="feature-card-detail">',
          '<span>' + String(feature.hookCount) + ' ' + escapeHtml(t('feature_hooks')) + '</span>',
          '<span>' + String(feature.enabledToolCount) + '/' + String(feature.toolCount) + ' ' + escapeHtml(t('feature_tools')) + '</span>',
          feature.description ? '<span>' + escapeHtml(feature.description) + '</span>' : '',
          '</div>',
          '</div>',
        ].join('');
        })
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
        '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_status_label')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(getFeatureStatusLabel(getFeatureStatus(selectedFeature))) + '</div></div>',
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
              '<div class="' + getStatusBadgeClass(tool.state || (tool.enabled ? 'enabled' : 'disabled')) + '">' + escapeHtml(tool.state === 'superseded' ? t('feature_tool_superseded') : tool.state === 'removed' ? t('feature_tool_removed') : tool.state === 'disabled' || tool.enabled === false ? t('feature_tool_disabled') : t('feature_tool_enabled')) + '</div>',
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

      const standaloneSection = (currentHookInspector.standaloneTools && currentHookInspector.standaloneTools.length > 0)
        ? [
          '<section class="hooks-section">',
          '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('standalone_tools_title')) + '</div><div class="hooks-section-meta">' + String(currentHookInspector.standaloneTools.length) + '</div></div>',
          '<div class="feature-tool-list">' + currentHookInspector.standaloneTools.map(tool => [
            '<div class="feature-tool-card">',
            '<div class="feature-tool-top">',
            '<div class="feature-tool-name">' + escapeHtml(tool.name) + '</div>',
            '<div class="' + getStatusBadgeClass(tool.state || 'enabled') + '">' + escapeHtml(tool.state === 'superseded' ? t('feature_tool_superseded') : tool.state === 'removed' ? t('feature_tool_removed') : tool.state === 'disabled' ? t('feature_tool_disabled') : t('feature_tool_enabled')) + '</div>',
            '</div>',
            '<div class="feature-tool-desc">' + escapeHtml(tool.description || '') + '</div>',
            tool.source ? '<div class="feature-tool-meta"><span class="feature-tool-pill">source: ' + escapeHtml(tool.source) + '</span></div>' : '',
            '</div>',
          ].join('')).join('') + '</div>',
          '</section>',
        ].join('')
        : '';

      return [
        '<div class="hooks-panel feature-detail-shell">',
        '<section class="hooks-section">',
        '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_all_features')) + '</div><div class="hooks-section-meta">' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_registered')) + '</div></div>',
        '<div class="feature-grid">' + featureCards + '</div>',
        '</section>',
        standaloneSection,
        detailOverlay,
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
`;
