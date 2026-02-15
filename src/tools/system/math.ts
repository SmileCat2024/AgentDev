import { createTool } from '../../core/tool.js';

// 计算器
export const calculatorTool = createTool({
  name: 'calculator',
  description: '计算数学表达式',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string' },
    },
    required: ['expression'],
  },
  execute: async ({ expression }) => {
    console.log(`[calculator] ${expression}`);
    return String(eval(expression));
  },
});
