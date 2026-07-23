export const VIEWER_JS_MCP = `    function renderMcpItems(items, typeLabel) {
      if (!Array.isArray(items) || items.length === 0) {
        return '<div class="feature-panel-empty"><div>' + escapeHtml(t('active_none')) + '</div></div>';
      }

      return '<div class="mcp-list">' + items.map((item) => {
        const name = item.name || item.uri || '';
        return [
        '<article class="mcp-item">',
        '<div class="mcp-item-head">',
        '<div class="mcp-item-name">' + escapeHtml(name) + '</div>',
        '<div class="mcp-item-type">' + escapeHtml(typeLabel) + '</div>',
        '</div>',
          '<div class="mcp-item-desc">' + escapeHtml(item.description || '') + '</div>',
          '</article>',
        ].join('');
      }).join('') + '</div>';
    }

    function renderMcpPanel() {
      if (!currentMcpInfo) {
        return '<div class="feature-panel-empty"><div>' + escapeHtml(t('mcp_loading')) + '</div></div>';
      }

      const info = currentMcpInfo;
      return [
        '<div class="mcp-panel">',
        '<section class="mcp-hero">',
        '<div class="hooks-kicker">' + escapeHtml(t('mcp_section_kicker')) + '</div>',
        '<div class="hooks-hero-title">' + escapeHtml(t('mcp_hero_title')) + '</div>',
        '<div class="hooks-hero-subtitle">' + escapeHtml(t('mcp_subtitle')) + '</div>',
        '<div class="mcp-status-pill">' + escapeHtml(info.enabled ? t('mcp_enabled') : t('mcp_disabled')) + '</div>',
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('panel_inspector')) + '</div>',
        '<div class="mcp-grid">',
        '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_endpoint')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.endpoint || '') + '</div></div>',
        '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_transport')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.transport || '') + '</div></div>',
        '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_tools')) + '</div><div class="mcp-stat-value">' + String((info.tools || []).length) + '</div></div>',
        '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_resources')) + '</div><div class="mcp-stat-value">' + String((info.resources || []).length) + '</div></div>',
        '</div>',
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_client_config')) + '</div>',
        '<div class="mcp-item-desc" style="margin-bottom:8px;">' + escapeHtml(t('mcp_claude_desktop')) + '</div>',
        '<pre class="mcp-code">' + escapeHtml(safePrettyJson(info.commands?.claudeDesktop?.json || {})) + '</pre>',
        '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(t('mcp_codex')) + '</div>',
        '<pre class="mcp-code">' + escapeHtml(safePrettyJson(info.commands?.codex?.json || {})) + '</pre>',
        '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(t('mcp_manual')) + '</div>',
        '<pre class="mcp-code">' + escapeHtml(info.commands?.curlInitialize || '') + '</pre>',
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_tool_list')) + '</div>',
        renderMcpItems(info.tools || [], t('mcp_item_tool')),
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_resource_list')) + '</div>',
        renderMcpItems(info.resources || [], t('mcp_item_resource')),
        '</section>',
        '<section class="feature-panel-section">',
        '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_prompt_list')) + '</div>',
        renderMcpItems(info.prompts || [], t('mcp_item_prompt')),
        '</section>',
        '</div>',
      ].join('');
    }

`;
