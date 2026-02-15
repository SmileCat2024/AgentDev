/**
 * 文件系统工具渲染模板
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
 * 文件读取渲染模板
 */
export const readFileRender: InlineRenderTemplate = {
  call: '<div class="bash-command">Read <span class="file-path">{{path}}</span></div>',
  result: (data) => `<pre class="bash-output" style="max-height:300px;">${escapeHtml(data)}</pre>`
};

/**
 * 文件写入渲染模板
 */
export const writeFileRender: InlineRenderTemplate = {
  call: '<div class="bash-command">Write <span class="file-path">{{path}}</span></div>',
  result: (data) => `<div style="color:var(--success-color)">✓ File written successfully</div>`
};

/**
 * 目录列表渲染模板
 */
export const listDirRender: InlineRenderTemplate = {
  call: '<div class="bash-command">List <span class="file-path">{{path}}</span></div>',
  result: (data) => {
    const files = (data || '').split('\n').filter((f: string) => f);
    return `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:4px; font-family:monospace; font-size:12px;">
      ${files.map((f: string) => `<div style="color:var(--text-primary);">${escapeHtml(f)}</div>`).join('')}
    </div>`;
  }
};
