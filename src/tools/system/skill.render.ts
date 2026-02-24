/**
 * Skill 工具渲染模板
 * 使用 viewer-worker.ts HTML 中的版本（Markdown 渲染）
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
 * Skill 调用渲染模板（Markdown 渲染）
 */
export const invokeSkillRender: InlineRenderTemplate = {
  call: (args) => `<div class="bash-command">Invoke Skill <span class="file-path">${escapeHtml(args.skill || '')}</span></div>`,
  result: (data, success) => {
    if (!success) return formatError(data);
    const str = String(data);
    // invoke_skill 返回的是 markdown 格式的技能文档，直接用 markdown 渲染
    return `<div class="file-content markdown-body" style="padding:12px; background:#0d1117; border-radius:6px; font-size:13px; max-height:600px; overflow-y:auto;">${str}</div>`;
  }
};

/**
 * 模板映射表
 */
export const TEMPLATES = {
  'skill': invokeSkillRender,
  'invoke_skill': invokeSkillRender,
};
