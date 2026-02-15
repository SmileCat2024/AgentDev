/**
 * 数据库工具的渲染模板
 * 展示如何为用户工具定义自定义渲染
 */

import type { InlineRenderTemplate } from '../../core/types.js';

export const renderTemplate: InlineRenderTemplate = {
  call: (args) => `<div class="bash-command">DB Query <span class="file-path">${args.database || 'default'}</span>: <span style="opacity:0.7">${args.query || ''}</span></div>`,
  result: (data, success) => {
    if (!success) {
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${String(data)}</span>
      </div>`;
    }
    const rows = data?.rows || [];
    const rowCount = data?.rowCount || rows.length;
    return `<div style="padding:8px;">
      <div style="font-size:11px; opacity:0.6; margin-bottom:8px;">
        Query returned ${rowCount} row${rowCount !== 1 ? 's' : ''}
      </div>
      ${rows.length > 0 ? `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead style="background:var(--hover-bg);">
            <tr>
              ${Object.keys(rows[0]).map(key => `<th style="padding:6px 10px; text-align:left; border-bottom:1px solid var(--border-color);">${key}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row: Record<string, unknown>) => `
              <tr style="border-bottom:1px solid var(--border-color);">
                ${Object.values(row).map((val: any) => `<td style="padding:6px 10px;">${val}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div style="color:var(--text-secondary); font-style:italic;">No results</div>'}
    </div>`;
  },
};
