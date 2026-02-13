/**
 * 提示词模板系统使用示例
 */

import { Agent, TemplateComposer, createOpenAILLM, loadConfig } from '../src/index.js';
import { fsTools } from '../src/index.js';

async function examples() {
  const config = await loadConfig();
  const llm = createOpenAILLM(config);

  // ========== 示例1: 直接字符串（向后兼容）==========
  const agent1 = new Agent({
    llm,
    tools: [fsTools.readFileTool, fsTools.writeFileTool],
    systemMessage: '你是一个编程助手。'
  });

  // ========== 示例2: 从文件加载 ==========
  const agent2 = new Agent({
    llm,
    tools: [fsTools.readFileTool, fsTools.writeFileTool],
    systemMessage: { file: 'prompt/system.md' }
  });

  // ========== 示例3: 使用组合器 ==========
  const agent3 = new Agent({
    llm,
    tools: [fsTools.readFileTool],
    systemMessage: new TemplateComposer()
      .add('你是一个 {{role}}。\n\n')
      .add('擅长领域：{{field}}\n\n')
      .add({ file: 'prompt/guidelines.md' })
  });

  // ========== 示例4: 动态设置系统提示词 ==========
  const agent4 = new Agent({ llm, tools: [fsTools.readFileTool] });
  agent4.setSystemPrompt(new TemplateComposer()
    .add('你是 {{role}}，专注于 {{task}}')
  );

  // ========== 示例5: 设置占位符变量 ==========
  agent4.setSystemContext({
    role: 'Python专家',
    task: '数据分析'
  });

  const result1 = await agent4.onCall('帮我分析一个CSV文件');
  console.log(result1);

  // ========== 示例6: 运行时切换角色 ==========
  agent4.setSystemContext({
    role: 'JavaScript专家',
    task: '前端开发'
  });
  agent4.reset(); // 重置上下文以应用新的系统提示词

  const result2 = await agent4.onCall('怎么实现防抖？');
  console.log(result2);

  // ========== 示例7: 条件拼接 ==========
  const agent5 = new Agent({ llm, tools: [fsTools.readFileTool] });
  agent5.setSystemPrompt(
    new TemplateComposer()
      .add('基础指令：你是一个助手。\n')
      .when(true, { file: 'prompt/safety.md' }) // 总是包含安全提示
      .when(process.env.DEBUG_MODE === 'true', '\n调试模式已启用。')
  );

  // ========== 示例8: 嵌套组合 ==========
  const basePrompt = new TemplateComposer()
    .add('你是 {{company}} 的 AI 助手。\n')
    .add('公司价值观：{{values}}\n');

  const agent6 = new Agent({ llm, tools: [fsTools.readFileTool] });
  agent6.setSystemPrompt(
    new TemplateComposer()
      .nest(basePrompt) // 嵌套基础提示词
      .add('\n当前任务：{{task}}')
  );

  agent6.setSystemContext({
    company: 'TechCorp',
    values: '创新、协作、卓越',
    task: '客户支持'
  });

  // ========== 示例9: 分隔符拼接 ==========
  const agent7 = new Agent({ llm, tools: [fsTools.readFileTool] });
  agent7.setSystemPrompt(
    new TemplateComposer()
      .add('规则1：不要编造信息')
      .add('规则2：保持简洁')
      .add('规则3：优先考虑安全')
      .joinWith('\n')
  );
}

// 运行示例
if (import.meta.url === `file://${process.argv[1]}`) {
  examples().catch(console.error);
}
