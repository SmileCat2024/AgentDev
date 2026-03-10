/**
 * WebSearch Feature 工具定义
 *
 * 提供 web_fetch 工具，用于获取网页内容
 */

import type { Tool } from '../../core/types.js';
import { createTool } from '../../core/tool.js';

/**
 * 创建 web_fetch 工具
 */
export function createWebFetchTool(): Tool {
  return createTool({
    name: 'web_fetch',
    description: '获取网页内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要获取的网页 URL' },
      },
      required: ['url'],
    },
    render: { call: 'web-fetch', result: 'web-fetch' },
    execute: async ({ url }) => {
      console.log(`[web_fetch] ${url}`);
      try {
        const response = await fetch(url);
        const text = await response.text();
        // 限制返回长度，避免内容过大
        return text.slice(0, 10000);
      } catch (error) {
        return `Error: ${error}`;
      }
    },
  });
}
