export const VIEWER_JS_STATE = `    // Feature 模板映射（从 API 动态加载）
    let FEATURE_TEMPLATE_MAP = {};

    // 加载 Feature 模板映射
    async function loadFeatureTemplateMap() {
      try {
        const response = await fetch('/api/templates/feature' + (currentAgentId ? '?agentId=' + encodeURIComponent(currentAgentId) : ''));
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
    const followLatestButton = document.getElementById('follow-latest-btn');
    const railButtons = Array.from(document.querySelectorAll('.rail-button'));
    const languageToggle = document.getElementById('language-toggle');
    const themeToggle = document.getElementById('theme-toggle');

    let currentAgentId = null;
    let allAgents = [];
    let currentMessages = [];
    let currentInputRequests = [];
    let choiceInputState = {};
    let toolRenderConfigs = {};
    let TOOL_NAMES = {};
    let contextMenuAgentId = null;
    let activeFeaturePanel = null;
    let featurePanelWidth = 320;
    let currentTheme = localStorage.getItem('agentdev-theme') || 'dark';
    let currentLanguage = localStorage.getItem('agentdev-language') || 'zh';
    let currentHookInspector = { lifecycleOrder: [], features: [], hooks: [] };
    let currentHookInspectorSignature = '';
    let currentOverviewSnapshot = getEmptyOverviewSnapshot();
    let currentOverviewSignature = '';
    let currentLogs = [];
    let currentLogsSignature = '';
    let currentMcpInfo = null;
    let logPanelScope = 'current';
    let logFilters = {
      search: '',
      level: 'all',
      feature: 'all',
      lifecycle: 'all',
    };
    let selectedOverviewLifecycle = 'StepFinish';
    let selectedFeatureName = null;
    let followLatestEnabled = true;
    let suppressFollowScrollEvent = false;
    let pendingFollowToBottom = false;
    let lastManualScrollIntentAt = 0;
    let followScrollSettleToken = 0;

`;
