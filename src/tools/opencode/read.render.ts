/**
 * Read 工具渲染模板
 * 使用 viewer-worker.ts HTML 中的版本（带代码高亮、行号显示）
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
export const readRender: InlineRenderTemplate = {
  call: (args) => {
    let output = `<div class="bash-command">Read <span class="file-path">${escapeHtml(args.filePath || '')}</span></div>`;
    if (args.offset !== undefined) {
      output += `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px;">lines ${args.offset}${args.limit ? '-' + (Number(args.offset) + Number(args.limit) - 1) : ''}</div>`;
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

    if (data.type === 'directory') {
      return `<div style="font-family:monospace; font-size:12px; line-height:1.6;">
        <div style="color:var(--accent-color); margin-bottom:8px;">📁 ${escapeHtml(data.path)}</div>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:4px;">
          ${data.entries.map((e: string) => {
            const isDir = e.endsWith('/') || e.endsWith('\\');
            return `<div style="color:${isDir ? 'var(--accent-color)' : 'var(--text-primary)'}; padding:2px 4px;">${escapeHtml(e)}</div>`;
          }).join('')}
        </div>
        <div style="color:var(--text-secondary); margin-top:8px; font-size:11px;">
          ${data.entries.length} of ${data.totalEntries} entries shown${data.truncated ? ' (truncated)' : ''}
        </div>
      </div>`;
    }

    // 处理文件内容 - 简洁的行号+代码布局
    const rawContent = data.content || '';
    const path = data.path || '';
    const ext = path.split('.').pop().toLowerCase();

    const lines = rawContent.split('\n');
    let startLine = data.offset || 1;
    const hasLinePrefix = lines.length > 0 && /^\d+: /.test(lines[0]);

    let resultHtml = '<div class="code-read-container">';

    lines.forEach((line: string, i: number) => {
      let lineNum, codeLine;
      if (hasLinePrefix) {
        const match = line.match(/^(\d+): (.*)$/);
        lineNum = match ? match[1] : ' ';
        codeLine = match ? match[2] : line;
      } else {
        lineNum = startLine + i;
        codeLine = line;
      }

      const codeExts = ['js', 'ts', 'py', 'java', 'c', 'cpp', 'rs', 'go', 'json', 'html', 'css', 'sh', 'bash', 'yaml', 'yml', 'xml', 'sql', 'md'];
      let highlightedLine = codeLine;
      if (codeExts.includes(ext)) {
        const lang = ext === 'ts' ? 'typescript' : (ext === 'js' ? 'javascript' : (ext === 'py' ? 'python' : ext));
        try {
          highlightedLine = hljs.highlight(codeLine, { language: lang }).value;
        } catch (e) {
          highlightedLine = hljs.highlightAuto(codeLine).value;
        }
      } else {
        highlightedLine = escapeHtml(codeLine);
      }

      resultHtml += `<div class="code-read-line"><span class="code-read-line-num">${lineNum}</span><span class="code-read-content">${highlightedLine}</span></div>`;
    });

    resultHtml += '</div>';

    return resultHtml;
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'read': readRender,
};
