/**
 * WebSearch Feature 工具定义
 *
 * 提供 web_fetch 工具，用于获取网页内容
 */

import type { Tool } from '@agentdevjs/core';
import { createTool } from '@agentdevjs/core';

/**
 * 创建 web_fetch 工具
 */
export function createWebFetchTool(): Tool {
  return createTool({
    name: 'web_fetch',
    description: '获取网页内容',
    parallelizable: true,
    // 声明超时契约：目标站点无响应时由框架计时终止，避免单次抓取长时间占用 turn
    timeout: {
      defaultMs: 30_000,
      maxMs: 60_000,
    },
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要获取的网页 URL' },
      },
      required: ['url'],
    },
    render: { call: 'web-fetch', result: 'web-fetch' },
    execute: async ({ url }, context) => {
      console.log(`[web_fetch] ${url}`);
      const throwAborted = () => {
        // 以标准 AbortError 形状抛出，执行器可据此归类为中断（timeout/user）
        throw new DOMException('Web fetch was aborted', 'AbortError');
      };
      try {
        const response = await fetch(url, { signal: context?.signal });
        const text = await response.text();
        if (context?.signal?.aborted) {
          throwAborted();
        }
        // 限制返回长度，避免内容过大
        return text.slice(0, 10000);
      } catch (error) {
        if (context?.signal?.aborted) {
          throwAborted();
        }
        return `Error: ${error}`;
      }
    },
  });
}
