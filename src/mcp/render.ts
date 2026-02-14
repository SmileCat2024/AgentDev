/**
 * MCP 工具渲染模板
 *
 * 定义 MCP 工具在 DebugHub 中的显示样式
 */

/**
 * 转义 HTML
 */
function escapeHtml(text: any): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

/**
 * MCP 工具渲染模板
 */
export const MCP_RENDER_TEMPLATES = {
  /**
   * MCP 工具调用显示
   */
  'mcp-tool': {
    call: (args: any) => {
      const server = args._server || 'unknown';
      const name = args._name || 'unknown';
      return `
        <div class="bash-command" style="
          border-left: 3px solid #ff6b6b;
          padding-left: 8px;
          margin: 4px 0;
        ">
          <span style="
            color: #ff6b6b;
            font-weight: bold;
            font-size: 11px;
            text-transform: uppercase;
          ">MCP</span>
          <span class="file-path" style="color: #c068ff;">${escapeHtml(server)}</span>
          <span style="color: #888;">::</span>
          <span style="color: #fff;">${escapeHtml(name)}</span>
        </div>
      `.trim();
    },
    result: (data: any, success = true) => {
      if (!success || data.error) {
        return `
          <div class="bash-output" style="
            border-left: 3px solid #ff4444;
            padding-left: 8px;
            color: #ff6b6b;
          ">
            <div style="font-weight: bold; margin-bottom: 4px;">MCP Error</div>
            <pre style="margin: 0; white-space: pre-wrap;">${escapeHtml(data.error || 'Unknown error')}</pre>
          </div>
        `.trim();
      }

      let content = '';

      // 文本内容
      if (data.content) {
        content += `<pre class="bash-output" style="max-height: 400px; overflow: auto;">${escapeHtml(data.content)}</pre>`;
      }

      // 结构化数据
      if (data.structuredContent) {
        content += `<details style="margin-top: 8px;">
          <summary style="cursor: pointer; color: var(--accent-color);">Structured Data</summary>
          <pre style="margin: 4px 0; padding: 8px; background: var(--bg-secondary);">${escapeHtml(JSON.stringify(data.structuredContent, null, 2))}</pre>
        </details>`;
      }

      // 图像
      if (data.images && data.images.length > 0) {
        content += `<div style="margin-top: 8px;">`;
        data.images.forEach((img: any) => {
          content += `<img src="data:${img.mimeType};base64,${img.data}" style="max-width: 100%; border-radius: 4px;" />`;
        });
        content += `</div>`;
      }

      // 资源
      if (data.resources && data.resources.length > 0) {
        content += `<div style="margin-top: 8px;">
          <div style="font-weight: bold; margin-bottom: 4px;">Resources:</div>`;
        data.resources.forEach((res: any) => {
          content += `<div style="padding: 4px; background: var(--bg-secondary); margin: 4px 0;">
            <div style="font-size: 11px; color: var(--text-secondary);">${escapeHtml(res.uri)}</div>
            ${res.text ? `<pre style="margin: 4px 0 0 0;">${escapeHtml(res.text)}</pre>` : ''}
          </div>`;
        });
        content += `</div>`;
      }

      // 元数据
      const meta = `
        <div style="
          font-size: 11px;
          opacity: 0.6;
          margin-top: 8px;
          display: flex;
          gap: 12px;
        ">
          <span>Server: ${escapeHtml(data.server)}</span>
          <span>Duration: ${data.duration}ms</span>
        </div>
      `;

      return content + meta;
    },
  },

  /**
   * MCP 结果 (简化版)
   */
  'mcp-result': {
    call: () => '<div class="bash-command">MCP Tool Call</div>',
    result: (data: any, success = true) => {
      return MCP_RENDER_TEMPLATES['mcp-tool'].result(data, success);
    },
  },
} as const;

/**
 * 获取 MCP 渲染模板
 */
export function getMCPRenderTemplate(toolName: string): string {
  return 'mcp-tool';
}

/**
 * 渲染 MCP 工具调用
 */
export function renderMCPToolCall(
  serverName: string,
  toolName: string,
  args: Record<string, any>
): string {
  const template = MCP_RENDER_TEMPLATES['mcp-tool'].call;
  if (typeof template === 'function') {
    return template({ _server: serverName, _name: toolName, ...args });
  }
  return template;
}

/**
 * 渲染 MCP 工具结果
 */
export function renderMCPToolResult(
  result: any,
  success = true
): string {
  const template = MCP_RENDER_TEMPLATES['mcp-tool'].result;
  if (typeof template === 'function') {
    return template(result, success);
  }
  return template;
}
