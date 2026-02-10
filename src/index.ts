/**
 * AgentDev - 轻量级 Agent 框架
 *
 * 所有导出都在这里，一目了然
 */

// 核心
export { Agent } from './core/agent.js';
export { Context } from './core/context.js';
export { createTool, ToolRegistry } from './core/tool.js';
export { runReactLoop } from './core/loop.js';
export { MessageViewer } from './core/viewer.js';

// 系统工具
export * as fsTools from './tools/fs.js';
export * as shellTools from './tools/shell.js';
export * as webTools from './tools/web.js';
export * as mathTools from './tools/math.js';

// 消息
export { system, user, assistant, toolResult, createMessage } from './core/message.js';

// LLM
export { OpenAILLM, createOpenAILLM } from './llm/openai.js';

// 配置
export { loadConfig, listConfigs } from './core/config.js';

// 类型
export type {
  Message,
  MessageRole,
  Tool,
  ToolCall,
  LLMResponse,
  LLMClient,
  AgentConfig,
  ContextMiddleware,
} from './core/types.js';

export type { ModelConfig, AgentConfigFile } from './core/config.js';
