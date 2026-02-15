/**
 * Skill 工具渲染模板
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
 * Skill 调用渲染模板
 */
export const invokeSkillRender: InlineRenderTemplate = {
  call: '<div class="bash-command">Skill <span class="file-path">{{skill}}</span></div>',
  result: (data) => `<pre class="bash-output" style="max-height:400px;">${escapeHtml(data)}</pre>`
};
