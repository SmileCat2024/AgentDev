export const VIEWER_JS_LOGS = `    function getLevelWeight(level) {
      const weights = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
      return weights[level] || 0;
    }

    function formatLogTimestamp(timestamp) {
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      });
    }

    function safePrettyJson(value) {
      try {
        return JSON.stringify(value, null, 2);
      } catch (e) {
        return String(value);
      }
    }

    function getFilteredLogs() {
      const search = logFilters.search.trim().toLowerCase();
      const minLevel = logFilters.level;
      return currentLogs.filter((entry) => {
        if (minLevel !== 'all' && getLevelWeight(entry.level) < getLevelWeight(minLevel)) {
          return false;
        }
        if (logFilters.feature !== 'all' && (entry.context?.feature || 'none') !== logFilters.feature) {
          return false;
        }
        if (logFilters.lifecycle !== 'all' && (entry.context?.lifecycle || 'none') !== logFilters.lifecycle) {
          return false;
        }
        if (search) {
          const haystack = [
            entry.message,
            entry.namespace,
            entry.context?.feature,
            entry.context?.lifecycle,
            entry.context?.hookMethod,
            entry.context?.toolName,
            entry.context?.agentName,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(search)) {
            return false;
          }
        }
        return true;
      });
    }

    function renderLogsPanel() {
      const filteredLogs = getFilteredLogs().slice().reverse();
      const featureOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.feature).filter(Boolean))).sort();
      const lifecycleOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.lifecycle).filter(Boolean))).sort();

      const toolbar = [
        '<section class="log-toolbar">',
        '<div class="log-filter-row">',
        '<div class="log-filter-label">' + escapeHtml(t('logs_scope')) + '</div>',
        '<div class="log-chip-group">',
        '<button type="button" class="log-chip' + (logPanelScope === 'current' ? ' active' : '') + '" onclick="window.setLogPanelScope(&quot;current&quot;)">' + escapeHtml(t('logs_scope_current')) + '</button>',
        '<button type="button" class="log-chip' + (logPanelScope === 'all' ? ' active' : '') + '" onclick="window.setLogPanelScope(&quot;all&quot;)">' + escapeHtml(t('logs_scope_all')) + '</button>',
        '</div>',
        '</div>',
        '<div class="log-filter-row">',
        '<div class="log-filter-label">' + escapeHtml(t('logs_search')) + '</div>',
        '<input class="log-input" type="text" value="' + escapeHtml(logFilters.search) + '" placeholder="' + escapeHtml(t('logs_search_placeholder')) + '" oninput="window.updateLogFilter(&quot;search&quot;, this.value)">',
        '</div>',
        '<div class="log-filter-row">',
        '<div class="log-filter-label">' + escapeHtml(t('logs_level')) + '</div>',
        '<select class="log-select" onchange="window.updateLogFilter(&quot;level&quot;, this.value)">',
        '<option value="all"' + (logFilters.level === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_all')) + '</option>',
        '<option value="debug"' + (logFilters.level === 'debug' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_debug')) + '</option>',
        '<option value="info"' + (logFilters.level === 'info' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_info')) + '</option>',
        '<option value="warn"' + (logFilters.level === 'warn' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_warn')) + '</option>',
        '<option value="error"' + (logFilters.level === 'error' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_error')) + '</option>',
        '</select>',
        '<select class="log-select" onchange="window.updateLogFilter(&quot;feature&quot;, this.value)">',
        '<option value="all"' + (logFilters.feature === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_feature_all')) + '</option>',
        featureOptions.map((feature) => '<option value="' + escapeHtml(feature) + '"' + (logFilters.feature === feature ? ' selected' : '') + '>' + escapeHtml(feature) + '</option>').join(''),
        '</select>',
        '<select class="log-select" onchange="window.updateLogFilter(&quot;lifecycle&quot;, this.value)">',
        '<option value="all"' + (logFilters.lifecycle === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_lifecycle_all')) + '</option>',
        lifecycleOptions.map((lifecycle) => '<option value="' + escapeHtml(lifecycle) + '"' + (logFilters.lifecycle === lifecycle ? ' selected' : '') + '>' + escapeHtml(lifecycle) + '</option>').join(''),
        '</select>',
        '</div>',
        '<div class="log-summary"><span>' + String(filteredLogs.length) + ' ' + escapeHtml(t('logs_total')) + '</span><span>' + escapeHtml(logPanelScope === 'current' ? (allAgents.find((agent) => agent.id === currentAgentId)?.name || t('active_none')) : t('logs_scope_all')) + '</span></div>',
        '</section>',
      ].join('');

      if (filteredLogs.length === 0) {
        return '<div class="log-panel">' + toolbar + '<div class="feature-panel-empty"><div>' + escapeHtml(t('logs_empty')) + '</div></div></div>';
      }

      const rows = filteredLogs.map((entry) => {
        const metaPills = [
          entry.context?.agentName ? '<span class="log-pill">' + escapeHtml(entry.context.agentName) + '</span>' : '',
          entry.context?.feature ? '<span class="log-pill">feature:' + escapeHtml(entry.context.feature) + '</span>' : '',
          entry.context?.lifecycle ? '<span class="log-pill">hook:' + escapeHtml(entry.context.lifecycle) + '</span>' : '',
          entry.context?.hookMethod ? '<span class="log-pill">' + escapeHtml(entry.context.hookMethod) + '()</span>' : '',
          entry.context?.toolName ? '<span class="log-pill">tool:' + escapeHtml(entry.context.toolName) + '</span>' : '',
          typeof entry.context?.step === 'number' ? '<span class="log-pill">step ' + String(entry.context.step) + '</span>' : '',
          typeof entry.context?.callIndex === 'number' ? '<span class="log-pill">call ' + String(entry.context.callIndex) + '</span>' : '',
        ].filter(Boolean).join('');

        const detailBlock = entry.data !== undefined
          ? '<details class="log-details"><summary>' + escapeHtml(t('logs_details')) + '</summary><pre>' + escapeHtml(safePrettyJson(entry.data)) + '</pre></details>'
          : '';

        return [
          '<article class="log-card">',
          '<div class="log-card-head">',
          '<div class="log-card-main">',
          '<span class="log-level ' + escapeHtml(entry.level) + '">' + escapeHtml(entry.level) + '</span>',
          '<span class="log-namespace">' + escapeHtml(entry.namespace) + '</span>',
          '</div>',
          '<div class="log-timestamp">' + escapeHtml(formatLogTimestamp(entry.timestamp)) + '</div>',
          '</div>',
          '<div class="log-card-body">',
          '<div class="log-message">' + escapeHtml(entry.message) + '</div>',
          metaPills ? '<div class="log-meta">' + metaPills + '</div>' : '',
          detailBlock,
          '</div>',
          '</article>',
        ].join('');
      }).join('');

      return '<div class="log-panel">' + toolbar + '<section class="log-list">' + rows + '</section></div>';
    }

`;
