export const VIEWER_JS_CHOICE_INPUT = `    function isChoiceInputRequest(req) {
      return !!req && req.mode === 'choices' && Array.isArray(req.questions) && req.questions.length > 0;
    }

    function getChoiceRequestById(requestId) {
      return (currentInputRequests || []).find(req => req.requestId === requestId) || null;
    }

    function getChoiceState(requestId) {
      if (!choiceInputState[requestId]) {
        choiceInputState[requestId] = {
          questionIndex: 0,
          answers: [],
          selectedIndex: 0,
          selectedIndexByQuestion: {},
          customTextByQuestion: {},
          supplementTextByOption: {},
          collapsed: false,
        };
      }
      return choiceInputState[requestId];
    }

    function getChoiceOptionCount(question) {
      const optionCount = Array.isArray(question?.options) ? Math.min(question.options.length, 4) : 0;
      return optionCount + (question?.allowCustom ? 1 : 0);
    }

    function buildChoiceAnswer(req, state, questionIndex) {
      const question = req?.questions?.[questionIndex] || {};
      const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
      const selectedIndex = state.selectedIndexByQuestion?.[question.id] ?? (questionIndex === state.questionIndex ? state.selectedIndex : 0);
      const isCustom = question.allowCustom && selectedIndex >= options.length;
      if (isCustom) {
        return {
          questionId: question.id,
          customText: (state.customTextByQuestion[question.id] || '').trim(),
        };
      }
      const selectedOption = options[selectedIndex];
      const supplementKey = question.id + ':' + (selectedOption?.id || '');
      const supplementText = selectedOption?.allowSupplement
        ? (state.supplementTextByOption?.[supplementKey] || '').trim()
        : undefined;
      return {
        questionId: question.id,
        optionId: selectedOption?.id,
        supplementText: supplementText || undefined,
      };
    }

    function rememberCurrentChoice(req, state) {
      const question = req?.questions?.[state.questionIndex] || {};
      if (!question.id) return;
      state.selectedIndexByQuestion[question.id] = state.selectedIndex || 0;
      state.answers[state.questionIndex] = buildChoiceAnswer(req, state, state.questionIndex);
    }

    function renderChoiceInputRequest(container, req) {
      const state = getChoiceState(req.requestId);
      const questions = Array.isArray(req.questions) ? req.questions : [];
      if (state.collapsed) {
        container.classList.add('choice-collapsed');
        const mini = document.createElement('button');
        mini.className = 'user-choice-mini';
        mini.type = 'button';
        mini.setAttribute('onclick', \`expandChoiceRequest('\${req.requestId}')\`);
        mini.innerHTML = \`
          <span class="user-choice-mini-title">\${escapeHtml(req.prompt || '等待你的选择')}</span>
          <span class="user-choice-mini-meta">\${Math.min((state.questionIndex || 0) + 1, questions.length)} / \${questions.length}</span>
        \`;
        container.appendChild(mini);
        return;
      }

      container.classList.remove('choice-collapsed');
      const questionIndex = Math.max(0, Math.min(state.questionIndex || 0, questions.length - 1));
      state.questionIndex = questionIndex;
      const question = questions[questionIndex] || {};
      const options = Array.isArray(question.options) ? question.options.slice(0, 4) : [];
      const hasCustom = !!question.allowCustom;
      const optionCount = options.length + (hasCustom ? 1 : 0);
      state.selectedIndex = Math.max(0, Math.min(state.selectedIndexByQuestion?.[question.id] ?? state.selectedIndex ?? 0, Math.max(0, optionCount - 1)));

      const card = document.createElement('div');
      card.className = 'user-input-card user-choice-card';
      card.tabIndex = 0;
      card.setAttribute('onkeydown', \`handleChoiceKey(event, '\${req.requestId}')\`);

      const optionHtml = options.map((option, index) => {
        const isActive = index === state.selectedIndex;
        const supplementKey = question.id + ':' + (option.id || '');
        const supplementText = state.supplementTextByOption?.[supplementKey] || '';
        const showSupplement = isActive && option.allowSupplement;
        const supplementLabel = option.supplementLabel || '';
        const supplementPlaceholder = option.supplementPlaceholder || '';
        return \`
          <div>
            <button class="user-choice-option \${isActive ? 'active' : ''}" type="button" onclick="selectChoiceOption('\${req.requestId}', \${index})">
              <span class="user-choice-key">\${index + 1}</span>
              <span>
                <span class="user-choice-label">\${escapeHtml(option.label || option.id || ('选项 ' + (index + 1)))}</span>
                \${option.description ? \`<span class="user-choice-description">\${escapeHtml(option.description)}</span>\` : ''}
              </span>
            </button>
            <div class="user-choice-supplement \${showSupplement ? 'active' : ''}">
              \${supplementLabel ? \`<div class="user-choice-supplement-label">\${escapeHtml(supplementLabel)}</div>\` : ''}
              <textarea id="choice-supplement-\${req.requestId}-\${index}" rows="2"
                oninput="updateChoiceSupplementText('\${req.requestId}', '\${supplementKey}', this.value); autoResize(this)"
                onkeydown="handleChoiceCustomKey(event, '\${req.requestId}')"
                placeholder="\${escapeHtml(supplementPlaceholder || '补充说明（可选）')}">\${escapeHtml(supplementText)}</textarea>
            </div>
          </div>
        \`;
      }).join('');

      const customIndex = options.length;
      const customActive = hasCustom && state.selectedIndex === customIndex;
      const customText = state.customTextByQuestion[question.id] || '';
      const customHtml = hasCustom ? \`
        <button class="user-choice-option \${customActive ? 'active' : ''}" type="button" onclick="selectChoiceOption('\${req.requestId}', \${customIndex})">
          <span class="user-choice-key">\${customIndex + 1}</span>
          <span>
            <span class="user-choice-label">\${escapeHtml(question.customLabel || '其他，我想补充')}</span>
            <span class="user-choice-description">选择后可以直接输入想说的话</span>
          </span>
        </button>
        <div class="user-choice-custom \${customActive ? 'active' : ''}">
          <textarea id="choice-custom-\${req.requestId}" rows="2"
            oninput="updateChoiceCustomText('\${req.requestId}', this.value); autoResize(this)"
            onkeydown="handleChoiceCustomKey(event, '\${req.requestId}')"
            placeholder="\${escapeHtml(question.customPlaceholder || '输入你的补充内容')}">\${escapeHtml(customText)}</textarea>
        </div>
      \` : '';

      card.innerHTML = \`
        <div class="user-choice-topline">
          <div class="user-choice-title">\${escapeHtml(req.prompt || '需要你做个选择')}</div>
          <div class="user-choice-progress">\${questionIndex + 1} / \${questions.length}</div>
          <button class="user-choice-close" type="button" title="临时收起" onclick="collapseChoiceRequest('\${req.requestId}')">×</button>
        </div>
        <div class="user-choice-question">\${escapeHtml(question.question || '')}</div>
        <div class="user-choice-options">
          \${optionHtml}
          \${customHtml}
        </div>
        <div class="user-choice-footer">
          <span>↑↓ 选项，←→ 题目，Enter 确认</span>
          <button class="user-choice-submit" type="button" onclick="confirmChoiceQuestion('\${req.requestId}')">\${questionIndex + 1 === questions.length ? '提交' : '下一题'}</button>
        </div>
      \`;

      container.appendChild(card);
      setTimeout(() => {
        const customInput = customActive ? document.getElementById(\`choice-custom-\${req.requestId}\`) : null;
        const activeOption = options[state.selectedIndex];
        const supplementInput = !customActive && activeOption?.allowSupplement
          ? document.getElementById('choice-supplement-' + req.requestId + '-' + state.selectedIndex)
          : null;
        const target = customInput || supplementInput || card;
        target.focus();
        if (customInput || supplementInput) {
          const el = customInput || supplementInput;
          const end = el.value.length;
          el.setSelectionRange(end, end);
          autoResize(el);
        }
      }, 30);
    }

    function rerenderChoiceRequest(requestId) {
      renderInputRequests(currentInputRequests || []);
    }

    window.selectChoiceOption = function(requestId, optionIndex) {
      const req = getChoiceRequestById(requestId);
      const state = getChoiceState(requestId);
      state.selectedIndex = optionIndex;
      const question = req?.questions?.[state.questionIndex];
      if (question?.id) {
        state.selectedIndexByQuestion[question.id] = optionIndex;
      }
      rerenderChoiceRequest(requestId);
    };

    window.collapseChoiceRequest = function(requestId) {
      const state = getChoiceState(requestId);
      const req = getChoiceRequestById(requestId);
      rememberCurrentChoice(req, state);
      state.collapsed = true;
      rerenderChoiceRequest(requestId);
    };

    window.expandChoiceRequest = function(requestId) {
      const state = getChoiceState(requestId);
      state.collapsed = false;
      rerenderChoiceRequest(requestId);
    };

    function collapsePrimaryChoiceRequest() {
      const request = (currentInputRequests || []).find(isChoiceInputRequest);
      if (request) {
        window.collapseChoiceRequest(request.requestId);
      }
    }

    window.updateChoiceCustomText = function(requestId, value) {
      const req = getChoiceRequestById(requestId);
      const state = getChoiceState(requestId);
      const question = req?.questions?.[state.questionIndex];
      if (question?.id) {
        state.customTextByQuestion[question.id] = value;
      }
    };

    window.updateChoiceSupplementText = function(requestId, supplementKey, value) {
      const state = getChoiceState(requestId);
      if (!state.supplementTextByOption) {
        state.supplementTextByOption = {};
      }
      state.supplementTextByOption[supplementKey] = value;
    };

    window.handleChoiceKey = function(event, requestId) {
      const req = getChoiceRequestById(requestId);
      if (!req) return;
      const state = getChoiceState(requestId);
      const question = req.questions[state.questionIndex] || {};
      const optionCount = getChoiceOptionCount(question);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.selectedIndex = Math.min(optionCount - 1, (state.selectedIndex || 0) + 1);
        if (question.id) state.selectedIndexByQuestion[question.id] = state.selectedIndex;
        rerenderChoiceRequest(requestId);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.selectedIndex = Math.max(0, (state.selectedIndex || 0) - 1);
        if (question.id) state.selectedIndexByQuestion[question.id] = state.selectedIndex;
        rerenderChoiceRequest(requestId);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        rememberCurrentChoice(req, state);
        state.questionIndex = Math.min(req.questions.length - 1, state.questionIndex + 1);
        state.selectedIndex = state.selectedIndexByQuestion[req.questions[state.questionIndex]?.id] ?? 0;
        rerenderChoiceRequest(requestId);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        rememberCurrentChoice(req, state);
        state.questionIndex = Math.max(0, state.questionIndex - 1);
        state.selectedIndex = state.selectedIndexByQuestion[req.questions[state.questionIndex]?.id] ?? 0;
        rerenderChoiceRequest(requestId);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        confirmChoiceQuestion(requestId);
      }
    };

    window.handleChoiceCustomKey = function(event, requestId) {
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
        event.preventDefault();
        confirmChoiceQuestion(requestId);
      }
    };

    window.confirmChoiceQuestion = async function(requestId) {
      const req = getChoiceRequestById(requestId);
      if (!req) return;
      const state = getChoiceState(requestId);
      const questions = req.questions || [];
      rememberCurrentChoice(req, state);

      // Validate supplement-required for current question
      const currentQuestion = questions[state.questionIndex];
      if (currentQuestion) {
        const currentAnswer = state.answers[state.questionIndex];
        if (currentAnswer && currentAnswer.optionId) {
          const selectedOption = (currentQuestion.options || []).find(o => o.id === currentAnswer.optionId);
          if (selectedOption && selectedOption.allowSupplement && selectedOption.supplementRequired) {
            const supplementKey = currentQuestion.id + ':' + currentAnswer.optionId;
            const supplementValue = (state.supplementTextByOption?.[supplementKey] || '').trim();
            if (!supplementValue) {
              const supplementInput = document.getElementById('choice-supplement-' + requestId + '-' + (currentQuestion.options.indexOf(selectedOption)));
              if (supplementInput) {
                supplementInput.focus();
                supplementInput.style.borderColor = '#dc3545';
                setTimeout(() => { supplementInput.style.borderColor = ''; }, 1500);
              }
              return;
            }
          }
        }
      }

      if (state.questionIndex < questions.length - 1) {
        state.questionIndex += 1;
        state.selectedIndex = state.selectedIndexByQuestion[questions[state.questionIndex]?.id] ?? 0;
        rerenderChoiceRequest(requestId);
        return;
      }

      const finalAnswers = questions.map((_, index) => state.answers[index] || buildChoiceAnswer(req, state, index));
      const summary = finalAnswers.map((item, index) => {
        const q = questions[index] || {};
        if (item.customText) return \`\${q.question || item.questionId}: \${item.customText}\`;
        const option = (q.options || []).find(candidate => candidate.id === item.optionId);
        let line = \`\${q.question || item.questionId}: \${option?.label || item.optionId || ''}\`;
        if (item.supplementText) line += \` (\${item.supplementText})\`;
        return line;
      }).join('\\n');

      try {
        const res = await fetch(\`/api/agents/\${currentAgentId}/input\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            input: summary,
            response: {
              kind: 'choices',
              choices: finalAnswers,
              text: summary,
            },
          }),
        });
        if (res.ok) {
          delete choiceInputState[requestId];
          poll();
        }
      } catch (e) {
        console.error('提交选择失败:', e);
      }
    };

    function syncRollbackActionButtons() {
      const allowRollback = !!getPrimaryInputRequest();
      const rows = container.querySelectorAll('.message-row');

      rows.forEach((row, index) => {
        const msg = currentMessages[index];
        const meta = row.querySelector('.message-meta');
        if (!meta) return;

        const existingButton = meta.querySelector('.message-action');
        const shouldShow = allowRollback && !!msg && msg.role === 'user';

        if (!shouldShow) {
          if (existingButton) {
            existingButton.remove();
          }
          return;
        }

        if (existingButton) {
          existingButton.setAttribute('onclick', 'requestRollbackEdit(' + index + ')');
          existingButton.style.display = '';
          return;
        }

        const button = document.createElement('button');
        button.className = 'message-action';
        button.type = 'button';
        button.textContent = '编辑此轮';
        button.setAttribute('onclick', 'requestRollbackEdit(' + index + ')');
        meta.appendChild(button);
      });
    }

    function updateRollbackActionVisibility() {
      syncRollbackActionButtons();
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
          body: JSON.stringify({
            requestId,
            input,
            response: {
              kind: 'text',
              text: input,
            },
          })
        });
        if (res.ok) {
          setFollowLatest(true, { scroll: true, behavior: 'smooth' });
          // 刷新输入请求列表
          poll();
        }
      } catch (e) {
        console.error('提交输入失败:', e);
      }
    }

    function getPrimaryInputRequest() {
      return Array.isArray(currentInputRequests) && currentInputRequests.length > 0
        ? currentInputRequests[0]
        : null;
    }

    function canRollbackMessage(msg) {
      return !!getPrimaryInputRequest() && !!msg && msg.role === 'user';
    }

    async function submitInputAction(requestId, actionId, payload = {}) {
      try {
        const res = await fetch(\`/api/agents/\${currentAgentId}/input\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            input: '',
            response: {
              kind: 'action',
              actionId,
              payload,
            },
          }),
        });
        if (res.ok) {
          poll();
        }
      } catch (e) {
        console.error('提交动作失败:', e);
      }
    }

    window.requestRollbackEdit = async function(messageIndex) {
      const request = getPrimaryInputRequest();
      if (!request) {
        console.warn('No pending input request available for rollback action');
        return;
      }

      const msg = currentMessages[messageIndex];
      if (!msg || msg.role !== 'user') {
        return;
      }

      const fallbackCallIndex = currentMessages
        .slice(0, messageIndex + 1)
        .filter(entry => entry.role === 'user')
        .length - 1;
      const callIndex = typeof msg.turn === 'number' ? msg.turn : fallbackCallIndex;

      await submitInputAction(request.requestId, 'rollback_to_call', {
        callIndex,
        draftInput: msg.content,
      });
    };

`;
