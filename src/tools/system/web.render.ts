/**
 * Web 获取工具渲染模板
 */

import type { InlineRenderTemplate } from '../../core/types.js';

/**
 * Web 获取渲染模板
 */
export const webFetchRender: InlineRenderTemplate = {
  call: '<div>GET <a href="{{url}}" target="_blank" style="color:var(--accent-color)">{{url}}</a></div>',
  result: (data) => `<div style="font-size:12px; opacity:0.8;">Fetched ${String(data).length} chars</div>`
};
