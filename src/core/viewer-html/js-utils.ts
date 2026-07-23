export const VIEWER_JS_UTILS = `
    function getFeatureStatus(feature) {
      return feature && feature.status ? feature.status : (feature && feature.enabled ? 'enabled' : 'partial');
    }

    function getFeatureStatusLabel(status) {
      if (status === 'removed') return t('feature_removed');
      if (status === 'disabled') return t('feature_disabled');
      if (status === 'partial') return t('feature_partial');
      return t('feature_enabled');
    }

    function getStatusBadgeClass(status) {
      return 'feature-badge status-' + escapeHtml(status || 'enabled');
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

    function isNearBottom() {
      const threshold = 48;
      return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
    }

    function updateFollowLatestButton() {
      if (!followLatestButton) return;
      const hasMessages = currentMessages.length > 0;
      followLatestButton.classList.toggle('hidden', !hasMessages);
      followLatestButton.classList.toggle('active', followLatestEnabled);
      followLatestButton.innerHTML =
        '<span class="follow-latest-dot"></span><span>' +
        escapeHtml(t(followLatestEnabled ? 'follow_latest_on' : 'follow_latest_off')) +
        '</span>';
    }

    function markManualScrollIntent() {
      lastManualScrollIntentAt = Date.now();
    }

    function hasRecentManualScrollIntent() {
      return Date.now() - lastManualScrollIntentAt < 500;
    }

    function animateScrollTo(targetTop, duration = 150) {
      const settleToken = ++followScrollSettleToken;
      lastManualScrollIntentAt = 0;
      suppressFollowScrollEvent = true;

      const startTop = container.scrollTop;
      const delta = targetTop - startTop;
      if (Math.abs(delta) < 1 || duration <= 0) {
        container.scrollTop = targetTop;
        suppressFollowScrollEvent = false;
        return;
      }

      const startAt = performance.now();
      const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

      const step = (now) => {
        if (settleToken !== followScrollSettleToken) {
          return;
        }

        const progress = Math.min(1, (now - startAt) / duration);
        container.scrollTop = startTop + delta * easeOutCubic(progress);

        if (progress < 1) {
          requestAnimationFrame(step);
          return;
        }

        container.scrollTop = targetTop;
        suppressFollowScrollEvent = false;
      };

      requestAnimationFrame(step);
    }

    function scrollToLatest(behavior = 'smooth') {
      const targetTop = container.scrollHeight;
      if (behavior === 'auto') {
        followScrollSettleToken += 1;
        lastManualScrollIntentAt = 0;
        suppressFollowScrollEvent = true;
        container.scrollTop = targetTop;
        suppressFollowScrollEvent = false;
        return;
      }

      animateScrollTo(targetTop, 70);
    }

    function setFollowLatest(enabled, options = {}) {
      const { scroll = false, behavior = 'smooth' } = options;
      followLatestEnabled = enabled;
      if (enabled) {
        lastManualScrollIntentAt = 0;
      }
      updateFollowLatestButton();
      if (enabled && scroll) {
        scrollToLatest(behavior);
      }
    }

    function scheduleScrollToLatest(behavior = 'smooth') {
      pendingFollowToBottom = true;
      requestAnimationFrame(() => {
        if (!pendingFollowToBottom) return;
        pendingFollowToBottom = false;
        scrollToLatest(behavior);
      });
    }

`;
