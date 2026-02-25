/**
 * 文件系统工具渲染模板
 * 使用 viewer-worker.ts HTML 中的版本
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
 * 格式化错误
 */
function formatError(data: any): string {
  const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  return `<div class="tool-error">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    <span>${escapeHtml(text)}</span>
  </div>`;
}

/**
 * 文件读取渲染模板（带智能类型识别和语法高亮）
 */
export const readFileRender: InlineRenderTemplate = {
  call: (args) => `<div class="bash-command">Read <span class="file-path">${escapeHtml(args.path || '')}</span></div>`,
  result: (data, success) => {
    if (!success) return formatError(data);
    const path = data.path || '';
    const ext = path.split('.').pop().toLowerCase();
    const str = String(data);

    if (ext === 'md' || ext === 'markdown') {
      return `<div class="file-content markdown-body" style="padding:12px; background:#0d1117; border-radius:6px; font-size:13px; max-height:600px; overflow-y:auto;">${str}</div>`;
    }

    const codeExts = ['js', 'ts', 'py', 'java', 'c', 'cpp', 'rs', 'go', 'json', 'html', 'css', 'sh', 'bash', 'yaml', 'yml', 'xml', 'sql'];
    if (codeExts.includes(ext)) {
      const lang = ext === 'ts' ? 'typescript' : (ext === 'js' ? 'javascript' : (ext === 'py' ? 'python' : ext));
      // 注意：语法高亮需要在浏览器中由 hljs 处理
      return `<pre class="bash-output" style="max-height:300px;">${escapeHtml(str)}</pre>`;
    }

    return `<pre class="bash-output" style="max-height:300px;">${escapeHtml(str)}</pre>`;
  }
};

/**
 * 文件写入渲染模板
 */
export const writeFileRender: InlineRenderTemplate = {
  call: (args) => `<div class="bash-command">Write <span class="file-path">${escapeHtml(args.path || '')}</span></div>`,
  result: (data, success) => {
    if (!success) return formatError(data);
    return `<div style="color:var(--success-color)">✓ File written successfully</div>`;
  }
};

/**
 * 目录列表渲染模板（带文件图标）
 */
export const listDirRender: InlineRenderTemplate = {
  call: (args) => `<div class="bash-command">List <span class="file-path">${escapeHtml(args.path || '.')}</span></div>`,
  result: (data, success) => {
    if (!success) return formatError(data);
    let str = String(data || '');
    if (str.includes('\\n')) str = str.replace(/\\n/g, '\n');
    const files = str.split('\n').filter(f => f.trim());

    if (files.length === 0) return `<div style="color:var(--text-secondary); font-style:italic; padding:8px;">Empty directory</div>`;
    return `<div class="ls-grid">
      ${files.map(f => {
        return `<div class="ls-item">
          <span class="ls-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="opacity:0.7"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          </span>
          <span class="ls-name" title="${escapeHtml(f)}" style="font-family: &quot;Fira Code&quot;, &quot;Cascadia Code&quot;, &quot;Source Code Pro&quot;, &quot;JetBrains Mono&quot;, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;">${escapeHtml(f)}</span>
        </div>`;
      }).join('')}
    </div>`;
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'file-read': readFileRender,
  'file-write': writeFileRender,
  'file-list': listDirRender,
};
