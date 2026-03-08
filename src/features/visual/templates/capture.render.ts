/**
 * capture_and_understand_window 工具渲染模板
 */

import type { InlineRenderTemplate } from '../../../core/types.js';

function escapeHtml(text: unknown): string {
  const str = String(text);
  return str.replace(/[&<>"']/g, (m) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]!)
  );
}

export default {
  call: (data: Record<string, any>) => {
    const hwnd = data.hwnd as string ?? '';
    return `
      <div class="visual-tool-call">
        <div class="tool-header">
          <span class="tool-name">📸 视觉理解</span>
        </div>
        <div class="tool-args">
          <span class="arg-label">窗口句柄:</span>
          <code class="arg-value">${escapeHtml(hwnd)}</code>
        </div>
      </div>
    `;
  },

  result: (data: Record<string, any>, success?: boolean) => {
    const result = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    // 判断是否包含错误
    const isError = !success || result.includes('截图失败') || result.includes('视觉理解失败');

    return `
      <div class="visual-tool-result ${isError ? 'error' : ''}">
        <div class="result-header">
          <span class="result-icon">${isError ? '❌' : '✅'}</span>
          <span class="result-title">${isError ? '失败' : '成功'}</span>
        </div>
        <pre class="result-content">${escapeHtml(result)}</pre>
      </div>
    `;
  },
} as const satisfies InlineRenderTemplate;
