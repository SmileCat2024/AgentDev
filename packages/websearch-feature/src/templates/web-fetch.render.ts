/**
 * Web Fetch 工具渲染模板（WebSearch Feature 内部模板）
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

/**
 * HTML 转义辅助函数
 */
function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

/** 结果预览长度上限：全文已进模型上下文，卡片只保留可读预览。 */
const PREVIEW_CHARS = 2000;

/**
 * Web Fetch 渲染模板
 */
const webFetchRender: InlineRenderTemplate = {
  call: (args: { url?: string }) => {
    const url = args.url || '';
    return `<div class="web-fetch-call">
      GET <a href="${escapeHtml(url)}" target="_blank" style="color:var(--accent-color)">${escapeHtml(url)}</a>
    </div>`;
  },
  result: (data: unknown) => {
    const content = String(data ?? '');
    // 如果是错误消息
    if (content.startsWith('Error:')) {
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(content)}</span>
      </div>`;
    }
    // 成功获取内容：宿主提供卡面与折叠，这里只做长度说明 + 文本预览（不设内层背景/滚动）
    return `<div class="web-fetch-result">
      <div class="tool-result-note">已获取 ${content.length} 字符${content.length > PREVIEW_CHARS ? '（预览截断）' : ''}</div>
      <pre class="bash-output">${escapeHtml(content.slice(0, PREVIEW_CHARS))}</pre>
    </div>`;
  }
};

export default webFetchRender;
