export const VIEWER_JS_MESSAGES = `    // 生成单条消息的 HTML
    function renderMessage(msg, index) {
      const role = msg.role;
      const msgId = \`msg-\${index}\`;
      let contentHtml = '';
      let metaHtml = \`<div class="role-badge">\${role}</div>\`;
      if (canRollbackMessage(msg)) {
        metaHtml += \`<button class="message-action" onclick="requestRollbackEdit(\${index})">编辑此轮</button>\`;
      }

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
        } else if (msg.content.startsWith('[Error:') || msg.content.startsWith('[API Error:')) {
          // 错误消息使用红色样式
          innerContent += \`<div class="tool-error">\${escapeHtml(msg.content)}</div>\`;
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
      updateRollbackActionVisibility();
      updateFollowLatestButton();
      if (followLatestEnabled) {
        scheduleScrollToLatest('smooth');
      }
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

      updateRollbackActionVisibility();
      updateFollowLatestButton();
      if (followLatestEnabled) {
        scheduleScrollToLatest('smooth');
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
        updateFollowLatestButton();
        return;
      }

      const html = messages.map((msg, index) => {
        const role = msg.role;
        const msgId = \`msg-\${index}\`;
        let contentHtml = '';
        let metaHtml = \`<div class="role-badge">\${role}</div>\`;
        if (canRollbackMessage(msg)) {
          metaHtml += \`<button class="message-action" onclick="requestRollbackEdit(\${index})">编辑此轮</button>\`;
        }

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

       updateRollbackActionVisibility();
      updateFollowLatestButton();
      if (followLatestEnabled) {
        scheduleScrollToLatest('auto');
      }
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
        await loadMcpInfo(false);
        poll();
      });
    });
`;
