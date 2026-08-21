export const VIEWER_JS_NOTIFICATIONS = `
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
      currentInputRequests = requests;
      const hasChoiceRequest = Array.isArray(requests) && requests.some(isChoiceInputRequest);

      // 清空现有内容
      container.innerHTML = '';
      container.classList.toggle('choice-input-active', hasChoiceRequest);
      container.classList.remove('choice-collapsed');
      container.onclick = hasChoiceRequest
        ? function(event) {
            if (event.target === container) {
              collapsePrimaryChoiceRequest();
            }
          }
        : null;

      for (const req of requests) {
        if (isChoiceInputRequest(req)) {
          renderChoiceInputRequest(container, req);
          continue;
        }

        const card = document.createElement('div');
        card.className = 'user-input-card';
        const actionsHtml = Array.isArray(req.actions) && req.actions.length > 0
          ? '<div class="user-input-actions">' + req.actions.map(action =>
              '<button class="user-input-action ' + escapeHtml(action.variant || 'secondary') + '" onclick="submitInputAction(\\'' + req.requestId + '\\', \\'' + escapeHtml(action.id) + '\\')">' + escapeHtml(action.label) + '</button>'
            ).join('') + '</div>'
          : '';
        card.innerHTML = \`
          <textarea class="user-input-textarea" rows="1" id="input-\${req.requestId}"
            onkeydown="handleInputKey(event, '\${req.requestId}')"
            oninput="autoResize(this)"
            placeholder="\${escapeHtml(req.placeholder || t('input_placeholder'))}"></textarea>
          <div class="user-input-footer">
            \${actionsHtml}
          </div>
        \`;
        container.appendChild(card);
        
        // Auto-focus
        setTimeout(() => {
          const el = document.getElementById(\`input-\${req.requestId}\`);
          if(el) {
             if (typeof req.initialValue === 'string' && req.initialValue.length > 0) {
               el.value = req.initialValue;
             }
             el.focus();
             const end = el.value.length;
             if (typeof el.setSelectionRange === 'function') {
               el.setSelectionRange(end, end);
             }
             autoResize(el);
          }
        }, 50);
      }
    }

`;
