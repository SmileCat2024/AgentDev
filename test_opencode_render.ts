/**
 * 测试 Opencode 工具渲染效果
 */

import { Agent } from './src/index.js';

// 创建一个测试 Agent
const agent = new Agent({
  llm: {
    chat: async () => ({ content: '', toolCalls: [] })
  },
  tools: [], // 使用默认工具
  name: 'Render Test'
});

console.log('=== Opencode 工具渲染效果调查 ===\n');

// 1. 检查工具列表
console.log('【1. 工具列表】');
const tools = agent.getAvailableTools();
const opencodeTools = tools.filter(t =>
  ['read', 'write', 'edit', 'glob', 'grep', 'ls'].includes(t.name)
);

opencodeTools.forEach(tool => {
  console.log(`  - ${tool.name}`);
  console.log(`    描述: ${tool.description.substring(0, 60)}...`);
  console.log(`    有render配置: ${!!tool.render}`);
  if (tool.render) {
    console.log(`    render.call类型: ${typeof tool.render.call}`);
    console.log(`    render.result类型: ${typeof tool.render.result}`);
  }
  console.log();
});

// 2. 检查渲染模板映射
import { OPENCODE_RENDER_TEMPLATES, OPENCODE_TOOLS_MAP } from './src/tools/opencode/index.js';

console.log('【2. 渲染模板映射】');
Object.keys(OPENCODE_RENDER_TEMPLATES).forEach(toolName => {
  const template = OPENCODE_RENDER_TEMPLATES[toolName];
  console.log(`  ${toolName}:`);
  console.log(`    call 类型: ${typeof template.call}`);
  console.log(`    result 类型: ${typeof template.result}`);
});

console.log('\n【3. 工具映射状态】');
OPENCODE_TOOLS_MAP.forEach((tool, name) => {
  console.log(`  ${name}: ${tool.name} (有render: ${!!tool.render})`);
});

console.log('\n=== 调查完成 ===');
