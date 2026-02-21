/**
 * Write 工具渲染模板
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
 * 文件写入渲染模板
 */
export const writeRender: InlineRenderTemplate = {
  call: '<div class="bash-command">Write <span class="file-path">{{filePath}}</span></div>',
  result: (data) => {
    const result = data as { filePath?: string; existed?: boolean; diff?: string; message?: string };

    return `<div style="color:var(--success-color)">✓ ${result.message || 'File written successfully'}</div>
      <details style="margin-top:8px;">
        <summary style="cursor:pointer; color:var(--accent-color);">View diff</summary>
        <pre style="background:var(--bg-secondary); padding:8px; margin-top:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:300px; overflow:auto;">${escapeHtml(result.diff || '')}</pre>
      </details>`;
  }
};
