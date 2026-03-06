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
 * Command 渲染模板
 */
export const commandRender = {
  call: (args: { command?: string }) => {
    const command = args.command || '';
    return `<div class="bash-command">> ${escapeHtml(command)}</div>`;
  },
  result: (data: any) => {
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
