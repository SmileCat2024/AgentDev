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
  call: '<div class="bash-command">Edit <span class="file-path">{{filePath}}</span></div>',
  result: (data) => {
    const result = data as { filePath?: string; diff?: string; additions?: number; deletions?: number; message?: string };

    // 解析 diff 获取简短摘要
    const diffLines = (result.diff || '').split('\n');
    const changes: string[] = [];

    for (const line of diffLines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        changes.push('<span style="color:var(--success-color)">' + escapeHtml(line.substring(0, 60)) + '</span>');
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        changes.push('<span style="color:var(--error-color)">' + escapeHtml(line.substring(0, 60)) + '</span>');
      }
      if (changes.length >= 5) break;
    }

    return `<div style="color:var(--success-color)">✓ ${result.message || 'Edit applied successfully'}</div>
      <div style="margin-top:8px; font-size:11px; color:var(--text-secondary);">
        <span style="color:var(--success-color)">+${result.additions || 0}</span>
        <span style="color:var(--error-color)"> -${result.deletions || 0}</span>
      </div>
      ${changes.length > 0 ? `<div style="margin-top:8px; font-family:monospace; font-size:11px; max-height:100px; overflow:hidden;">${changes.slice(0, 3).join('<br>')}</div>` : ''}
      <details style="margin-top:8px;">
        <summary style="cursor:pointer; color:var(--accent-color);">View full diff</summary>
        <pre style="background:var(--bg-secondary); padding:8px; margin-top:8px; border-radius:4px; font-family:monospace; font-size:11px; max-height:300px; overflow:auto;">${escapeHtml(result.diff || '')}</pre>
      </details>`;
  }
};
