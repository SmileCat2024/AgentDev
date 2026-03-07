/**
 * Shell/Bash 工具渲染模板
 */

/**
 * HTML 转义辅助函数
 */
function escapeHtml(text: any): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

/**
 * 格式化错误
 */
function formatError(data: any): string {
  // 提取错误消息
  let errorMessage = '';

  if (data === null || data === undefined) {
    errorMessage = 'Command failed';
  } else if (typeof data === 'object' && 'error' in data) {
    errorMessage = String(data.error);
  } else if (typeof data === 'string') {
    errorMessage = data;
  } else {
    errorMessage = JSON.stringify(data, null, 2);
  }

  return `<div class="tool-error">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    <span>${escapeHtml(errorMessage)}</span>
  </div>`;
}

/**
 * Command 渲染模板
 */
export const commandRender = {
  call: (args: { command?: string }) => {
    const command = args.command || '';
    return `<div class="bash-command">> ${escapeHtml(command)}</div>`;
  },
  result: (data: any, success?: boolean) => {
    if (!success) {
      return formatError(data);
    }
    return `<pre class="bash-output">${escapeHtml(data)}</pre>`;
  }
};

/**
 * Bash 渲染模板（别名）
 */
export const bashRender = commandRender;

/**
 * Shell 渲染模板（别名）
 */
export const shellRender = commandRender;
