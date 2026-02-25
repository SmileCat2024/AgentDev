/**
 * Edit 工具渲染模板
 */

import type { InlineRenderTemplate } from '../../core/types.js';

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
 * 文件编辑渲染模板
 */
export const editRender: InlineRenderTemplate = {
  call: (args) => `<div class="bash-command">Edit <span class="file-path">${escapeHtml(args.filePath || '')}</span></div>`,
  result: (data, success) => {
    if (!success) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(text)}</span>
      </div>`;
    }

    const diffContent = data.diff || '';
    if (!diffContent) {
      return `<div style="color:var(--success-color)">✓ No changes made</div>`;
    }

    // 使用 Diff2Html 生成 Diff
    try {
      return Diff2Html.html(diffContent, {
        drawFileList: false,
        matching: 'lines',
        outputFormat: 'side-by-side',
        colorScheme: 'dark'
      });
    } catch(e) {
      return `<pre style="background:var(--hover-bg); padding:8px;">${escapeHtml(diffContent)}</pre>`;
    }
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'edit': editRender,
};
