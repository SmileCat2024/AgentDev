export const VIEWER_JS_INSPECTOR = `    function shortenSourcePath(value) {
      if (!value) return '';
      const normalized = String(value).replace(/\\\\/g, '/');
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

    function getEmptyOverviewSnapshot() {
      return {
        updatedAt: 0,
        context: {
          messageCount: 0,
          charCount: 0,
          toolCallCount: 0,
          turnCount: 0,
        },
        usageStats: {
          totalUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          calls: [],
          totalRequests: 0,
          totalCacheHitRequests: 0,
        },
      };
    }

    function normalizeOverviewSnapshot(snapshot) {
      const empty = getEmptyOverviewSnapshot();
      if (!snapshot || typeof snapshot !== 'object') {
        return empty;
      }

      return {
        updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0,
        context: {
          messageCount: typeof snapshot.context?.messageCount === 'number' ? snapshot.context.messageCount : 0,
          charCount: typeof snapshot.context?.charCount === 'number' ? snapshot.context.charCount : 0,
          toolCallCount: typeof snapshot.context?.toolCallCount === 'number' ? snapshot.context.toolCallCount : 0,
          turnCount: typeof snapshot.context?.turnCount === 'number' ? snapshot.context.turnCount : 0,
        },
        usageStats: {
          totalUsage: {
            inputTokens: typeof snapshot.usageStats?.totalUsage?.inputTokens === 'number' ? snapshot.usageStats.totalUsage.inputTokens : 0,
            outputTokens: typeof snapshot.usageStats?.totalUsage?.outputTokens === 'number' ? snapshot.usageStats.totalUsage.outputTokens : 0,
            totalTokens: typeof snapshot.usageStats?.totalUsage?.totalTokens === 'number' ? snapshot.usageStats.totalUsage.totalTokens : 0,
            cacheCreationTokens: typeof snapshot.usageStats?.totalUsage?.cacheCreationTokens === 'number' ? snapshot.usageStats.totalUsage.cacheCreationTokens : 0,
            cacheReadTokens: typeof snapshot.usageStats?.totalUsage?.cacheReadTokens === 'number' ? snapshot.usageStats.totalUsage.cacheReadTokens : 0,
            reasoningTokens: typeof snapshot.usageStats?.totalUsage?.reasoningTokens === 'number' ? snapshot.usageStats.totalUsage.reasoningTokens : 0,
            audioTokens: typeof snapshot.usageStats?.totalUsage?.audioTokens === 'number' ? snapshot.usageStats.totalUsage.audioTokens : 0,
          },
          calls: Array.isArray(snapshot.usageStats?.calls) ? snapshot.usageStats.calls.map((call) => ({
            ...call,
            cacheHitRequests: typeof call?.cacheHitRequests === 'number' ? call.cacheHitRequests : 0,
          })) : [],
          totalRequests: typeof snapshot.usageStats?.totalRequests === 'number' ? snapshot.usageStats.totalRequests : 0,
          totalCacheHitRequests: typeof snapshot.usageStats?.totalCacheHitRequests === 'number' ? snapshot.usageStats.totalCacheHitRequests : 0,
        },
      };
    }

    function getOverviewSignature(snapshot) {
      return JSON.stringify(normalizeOverviewSnapshot(snapshot));
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
        standaloneTools: raw.standaloneTools || undefined,
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

    function setCurrentOverviewSnapshot(snapshot) {
      const normalized = normalizeOverviewSnapshot(snapshot);
      currentOverviewSnapshot = normalized;
      currentOverviewSignature = getOverviewSignature(normalized);
    }

    function setCurrentLogs(logs) {
      currentLogs = Array.isArray(logs) ? logs : [];
      currentLogsSignature = JSON.stringify({
        count: currentLogs.length,
        last: currentLogs.length > 0 ? currentLogs[currentLogs.length - 1].id : null,
      });
    }

    function formatMetricNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '0';
      }
      return value.toLocaleString();
    }

    function formatRate(numerator, denominator) {
      if (!denominator) {
        return '0%';
      }
      return Math.round((numerator / denominator) * 100) + '%';
    }

    function getLatestCallSummary(overview) {
      const calls = Array.isArray(overview?.usageStats?.calls) ? overview.usageStats.calls : [];
      if (calls.length === 0) return null;
      return calls.slice().sort((a, b) => (a.callIndex || 0) - (b.callIndex || 0))[calls.length - 1];
    }

    function getUsageBreakdown(summary, fallbackRequests = 0) {
      const totalUsage = summary?.totalUsage || {};
      const totalTokens = totalUsage.totalTokens || 0;
      const inputTokens = totalUsage.inputTokens || 0;
      const outputTokens = totalUsage.outputTokens || 0;
      const requests = typeof summary?.stepCount === 'number'
        ? summary.stepCount
        : fallbackRequests;
      const cacheHitRequests = typeof summary?.cacheHitRequests === 'number'
        ? summary.cacheHitRequests
        : 0;

      return {
        inputTokens,
        outputTokens,
        totalTokens,
        requests,
        cacheHitRequests,
        cacheMissRequests: Math.max(0, requests - cacheHitRequests),
        cacheHitRate: formatRate(cacheHitRequests, requests),
        avgPerRequest: requests > 0 ? Math.round(totalTokens / requests) : 0,
        cacheReadTokens: totalUsage.cacheReadTokens || 0,
        cacheCreationTokens: totalUsage.cacheCreationTokens || 0,
        inputShare: totalTokens > 0 ? Math.round((inputTokens / totalTokens) * 100) : 0,
        outputShare: totalTokens > 0 ? Math.round((outputTokens / totalTokens) * 100) : 0,
      };
    }

    function renderTokenBar(inputTokens, outputTokens) {
      const total = inputTokens + outputTokens;
      const inputWidth = total > 0 ? (inputTokens / total) * 100 : 50;
      const outputWidth = total > 0 ? (outputTokens / total) * 100 : 50;
      return [
        '<div class="usage-bar">',
        '<div class="usage-bar-fill input" style="width:' + inputWidth + '%"></div>',
        '<div class="usage-bar-fill output" style="width:' + outputWidth + '%"></div>',
        '</div>',
      ].join('');
    }

    function renderRateRing(percent, label, meta) {
      const safePercent = Math.max(0, Math.min(100, percent));
      return [
        '<div class="rate-ring-card">',
        '<div class="rate-ring" style="--ring-percent:' + safePercent + ';">',
        '<div class="rate-ring-inner">',
        '<div class="rate-ring-value">' + safePercent + '%</div>',
        '<div class="rate-ring-label">' + escapeHtml(label) + '</div>',
        '</div>',
        '</div>',
        '<div class="rate-ring-meta">' + escapeHtml(meta) + '</div>',
        '</div>',
      ].join('');
    }

    function renderUsageCard(title, summaryLabel, breakdown) {
      return [
        '<div class="usage-card">',
        '<div class="usage-card-header">',
        '<div>',
        '<div class="usage-card-title">' + escapeHtml(title) + '</div>',
        '<div class="usage-card-subtitle">' + escapeHtml(summaryLabel) + '</div>',
        '</div>',
        '<div class="usage-card-total">' + formatMetricNumber(breakdown.totalTokens) + '</div>',
        '</div>',
        renderTokenBar(breakdown.inputTokens, breakdown.outputTokens),
        '<div class="usage-split-legend">',
        '<span><i class="legend-dot input"></i>' + escapeHtml(t('metric_input_tokens')) + ' ' + formatMetricNumber(breakdown.inputTokens) + '</span>',
        '<span><i class="legend-dot output"></i>' + escapeHtml(t('metric_output_tokens')) + ' ' + formatMetricNumber(breakdown.outputTokens) + '</span>',
        '</div>',
        '<div class="usage-stat-grid">',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.requests) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_avg_per_request')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.avgPerRequest) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_input_share')) + '</div><div class="usage-stat-cell-value">' + breakdown.inputShare + '%</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_output_share')) + '</div><div class="usage-stat-cell-value">' + breakdown.outputShare + '%</div></div>',
        '</div>',
        '</div>',
      ].join('');
    }

    function renderCacheCard(title, breakdown) {
      const percent = breakdown.requests > 0
        ? Math.round((breakdown.cacheHitRequests / breakdown.requests) * 100)
        : 0;
      return [
        '<div class="usage-card cache-card">',
        '<div class="usage-card-header">',
        '<div class="usage-card-title">' + escapeHtml(title) + '</div>',
        '<div class="usage-card-subtitle">' + escapeHtml(t('metric_cache_hit_rate')) + '</div>',
        '</div>',
        renderRateRing(percent, t('metric_cache_hit_rate'), breakdown.cacheHitRequests + ' / ' + breakdown.requests),
        '<div class="usage-stat-grid">',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_hit_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheHitRequests) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_miss_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheMissRequests) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_read')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheReadTokens) + '</div></div>',
        '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_write')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheCreationTokens) + '</div></div>',
        '</div>',
        '</div>',
      ].join('');
    }

    function renderContextChip(label, value, meta) {
      return [
        '<div class="context-chip">',
        '<div class="context-chip-label">' + escapeHtml(label) + '</div>',
        '<div class="context-chip-value">' + escapeHtml(value) + '</div>',
        '<div class="context-chip-meta">' + escapeHtml(meta) + '</div>',
        '</div>',
      ].join('');
    }

    function setCurrentMcpInfo(info) {
      currentMcpInfo = info || null;
    }

`;
