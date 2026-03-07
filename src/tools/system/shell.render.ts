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
 * 格式化输出数据（处理对象类型）
 */
function formatOutput(data: any): string {
  console.log('[shell.render] formatOutput input:', {
    type: typeof data,
    value: data,
    keys: data ? Object.keys(data) : null,
    isError: data instanceof Error,
    constructor: data?.constructor?.name
  });

  if (data === null || data === undefined) {
    return '';
  }
  if (typeof data === 'string') {
    console.log('[shell.render] formatOutput: string input');
    return data;
  }
  if (typeof data === 'object') {
    // 处理 Error 对象
    if (data instanceof Error) {
      console.log('[shell.render] formatOutput: Error object, message =', data.message);
      return data.message;
    }
    // 处理包含 stdout/stderr 的对象
    if ('stdout' in data || 'stderr' in data) {
      const stdout = data.stdout || '';
      const stderr = data.stderr || '';
      console.log('[shell.render] formatOutput: stdout/stderr object, output =', stdout + stderr);
      return stdout + stderr;
    }
    // 处理包含 error 字段的对象
    if ('error' in data) {
      const errorValue = data.error;
      console.log('[shell.render] formatOutput: error field, type =', typeof errorValue, 'value =', errorValue);
      if (typeof errorValue === 'string') {
        return errorValue;
      }
      if (errorValue instanceof Error) {
        return errorValue.message;
      }
      const jsonStr = JSON.stringify(data, null, 2);
      console.log('[shell.render] formatOutput: error field is object, json =', jsonStr);
      return jsonStr;
    }
    // 其他对象类型：转 JSON
    const jsonStr = JSON.stringify(data, null, 2);
    console.log('[shell.render] formatOutput: generic object, json =', jsonStr);
    return jsonStr;
  }
  console.log('[shell.render] formatOutput: primitive, String() =', String(data));
  return String(data);
}

/**
 * 格式化错误
 */
function formatError(data: any): string {
  const text = formatOutput(data);
  return `<div class="tool-error">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    <span>${escapeHtml(text)}</span>
  </div>`;
}

/**
 * Command 渲染模板
 */
export const commandRender = {
  call: (args: { command?: string }) => {
    const command = args.command || '';
    console.log('[shell.render] call: command =', command);
    return `<div class="bash-command">> ${escapeHtml(command)}</div>`;
  },
  result: (data: any, success?: boolean) => {
    console.log('[shell.render] result: success =', success, 'data =', data);
    if (!success) {
      console.log('[shell.render] result: ERROR branch, calling formatError');
      return formatError(data);
    }
    console.log('[shell.render] result: SUCCESS branch, calling formatOutput');
    const output = formatOutput(data);
    return `<pre class="bash-output">${escapeHtml(output)}</pre>`;
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
