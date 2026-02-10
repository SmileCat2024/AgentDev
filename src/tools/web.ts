import { createTool } from '../core/tool.js';

// 网页获取
export const webFetchTool = createTool({
  name: 'web_fetch',
  description: '获取网页内容',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
    },
    required: ['url'],
  },
  execute: async ({ url }) => {
    console.log(`[web_fetch] ${url}`);
    try {
      const response = await fetch(url);
      const text = await response.text();
      return text.slice(0, 10000);
    } catch (error) {
      return `Error: ${error}`;
    }
  },
});
