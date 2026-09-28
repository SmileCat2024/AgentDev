/**
 * read_image 渲染模板
 *
 * call：读取图片 + 路径。result：文件信息行（路径等宽 + 大小/格式 chips）。
 * 图片缩略图由宿主按消息 images 字段自动渲染（renderUserImages），
 * 模板不重复处理图片本体。
 */

import type { InlineRenderTemplate } from '@agentdevjs/core';

function escapeHtml(text: unknown): string {
  const str = String(text);
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]!);
}

/** execute 成功文本的固定形态：已读取图片文件: {path}（{kb} KB, {mime}） */
const READ_OK_RE = /^已读取图片文件: (.+)（(\d+(?:\.\d+)?) KB, (.+)）$/;

export default {
  call: (args: { path?: string }) => {
    return `<div class="bash-command">读取图片 <span class="file-path">${escapeHtml(args?.path || '')}</span></div>`;
  },
  result: (data: unknown, success?: boolean) => {
    const text = typeof data === 'string' ? data : String(data ?? '');
    if (!success || text.startsWith('错误：')) {
      return `<div class="tool-error"><span>${escapeHtml(text || '读取图片失败')}</span></div>`;
    }
    const m = READ_OK_RE.exec(text);
    if (m) {
      return `<div class="bash-command"><span class="file-path" title="${escapeHtml(m[1])}">${escapeHtml(m[1])}</span></div>`
        + `<div class="tool-chips">`
        + `<span class="tool-chip">${escapeHtml(m[2])} KB</span>`
        + `<span class="tool-chip">${escapeHtml(m[3])}</span>`
        + `</div>`;
    }
    return `<div class="tool-plain-text">${escapeHtml(text)}</div>`;
  },
} as const satisfies InlineRenderTemplate;
