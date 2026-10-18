/**
 * Batch Replace 工具渲染模板
 */

import type { InlineRenderTemplate } from '../../../core/types.js';

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
 * 跨文件批量替换渲染模板
 */
export default {
  call: (args) => {
    let output = `<div class="bash-command">Batch Replace <span class="pattern">${escapeHtml(args.find || '')}</span></div>`;
    const patterns = Array.isArray(args.paths) ? args.paths : [];
    if (patterns.length > 0) {
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px;">in ${escapeHtml(patterns.join(', '))}</div>`;
    }
    if (args.regex === true) {
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px;">(regex)</div>`;
    }
    return output;
  },
  result: (data, success) => {
    if (!success) {
      const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      return `<div class="tool-error">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <span>${escapeHtml(text)}</span>
      </div>`;
    }

    const notes = [];
    if (data.diffTruncated) {
      notes.push('<div class="tool-result-note tool-result-warning">Diff truncated</div>');
    }
    if (data.escapeNormalized) {
      notes.push('<div class="tool-result-note">Escape sequences normalized</div>');
    }

    const diffContent = typeof data.diff === 'string' ? data.diff : '';
    if (diffContent) {
      // 与 edit/write 一致：Diff2Html 渲染差异，末尾追加统计与截断提示
      let html;
      try {
        html = stripViewedCheckbox(Diff2Html.html(diffContent, {
          drawFileList: false,
          matching: 'lines',
          outputFormat: 'side-by-side',
          colorScheme: 'dark'
        }));
      } catch {
        html = `<pre style="background:var(--hover-bg); padding:8px;">${escapeHtml(diffContent)}</pre>`;
      }
      const total = data.totalReplacements ?? 0;
      const files = data.filesMatched ?? 0;
      notes.unshift(`<div class="tool-result-note">Replaced ${total} occurrence${total !== 1 ? 's' : ''} across ${files} file${files !== 1 ? 's' : ''}</div>`);
      return html + notes.join('');
    }

    // 无 display 的历史会话回退：文本通道的逐文件计数列表
    if (Array.isArray(data.perFile) && data.perFile.length > 0) {
      const rows = data.perFile.map(item =>
        `<div class="tool-search-file"><div class="tool-search-path" title="${escapeHtml(item.file)}">${escapeHtml(item.file)}</div><div class="tool-result-note">${item.count} replacement${item.count !== 1 ? 's' : ''}</div></div>`
      );
      const total = data.totalReplacements ?? 0;
      notes.unshift(`<div class="tool-result-note">Replaced ${total} occurrence${total !== 1 ? 's' : ''} across ${data.perFile.length} file${data.perFile.length !== 1 ? 's' : ''}</div>`);
      return `<div class="tool-search-results">${rows.join('')}${notes.join('')}</div>`;
    }

    const message = data.message || 'No occurrences found; no files were modified';
    return `<div style="color:var(--warning-color)">${escapeHtml(message)}</div>`;
  }
} as const satisfies InlineRenderTemplate;

// Diff2Html 3.x 无条件在每个 diff 文件头输出 Viewed 折叠复选框（无配置
// 开关），是与宿主行级折叠并存的块内折叠控件，统一移除。
function stripViewedCheckbox(html: string): string {
  return html.replace(/<label class="d2h-file-collapse">[\s\S]*?<\/label>/g, '');
}

declare const Diff2Html: any;
