/**
 * Web Fetch 工具渲染模板（WebSearch Feature 内部模板）
 */

import type { InlineRenderTemplate } from '../../../core/types.js';

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
    // 成功获取内容
    return `<div class="web-fetch-result">
      <div style="font-size:12px; opacity:0.8; margin-bottom:4px;">Fetched ${content.length} chars</div>
      <pre style="background:var(--bg-secondary); padding:8px; border-radius:4px; overflow:auto; max-height:300px;">${escapeHtml(content.slice(0, 1000))}${content.length > 1000 ? '\n...(truncated)' : ''}</pre>
    </div>`;
  }
};

export default webFetchRender;
