/**
 * OpenAI LLM 适配器
 * 实现 LLMClient 接口
 */

import type { LLMClient, Message, Tool, LLMResponse, ToolCall } from '../core/types.js';
import OpenAI from 'openai';

// GLM-4.7等模型扩展了OpenAI的响应格式，添加了reasoning_content字段
interface ExtendedChatCompletionMessage extends OpenAI.Chat.ChatCompletionMessage {
  reasoning_content?: string;
}

export class OpenAILLM implements LLMClient {
  private client: OpenAI;
  private modelName: string;

  constructor(apiKey: string, modelName: string = 'gpt-4o', baseUrl?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });
    this.modelName = modelName;
  }

  /**
   * 聊天 - 核心方法
   */
  async chat(messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    // 转换消息格式为 OpenAI 格式
    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map(m => {
      const base = { content: m.content };
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId! };
      }
      return { role: m.role, ...base };
    }) as OpenAI.Chat.ChatCompletionMessageParam[];

    // 转换工具格式
    const chatTools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    // 调用 OpenAI API
    const response = await this.client.chat.completions.create({
      model: this.modelName,
      messages: chatMessages,
      tools: chatTools.length > 0 ? chatTools : undefined,
    });

    const choice = response.choices[0];
    const message = choice.message as ExtendedChatCompletionMessage;

    // 解析工具调用
    const toolCalls: ToolCall[] | undefined = message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    // 提取思考内容（GLM-4.7等模型的扩展字段）
    const reasoning = message.reasoning_content;

    return {
      content: message.content || '',
      toolCalls,
      reasoning,
    };
  }
}

import type { ModelConfig, AgentConfigFile } from '../core/config.js';

/**
 * 从配置创建 OpenAI LLM 实例
 *
 * @example
 *   // 方式1：传入配置文件对象（推荐）
 *   const llm = createOpenAILLM(config);
 *
 * @example
 *   // 方式2：传入模型配置
 *   const llm = createOpenAILLM(config.defaultModel);
 *
 * @example
 *   // 方式3：单独传参
 *   const llm = createOpenAILLM(apiKey, 'gpt-4o', baseUrl);
 *
 * @example
 *   // 方式4：自定义配置
 *   const llm = createOpenAILLM({ apiKey: 'xxx', model: 'gpt-4o' });
 */
export function createOpenAILLM(config: AgentConfigFile): OpenAILLM;
export function createOpenAILLM(modelConfig: ModelConfig): OpenAILLM;
export function createOpenAILLM(
  apiKey: string,
  modelName: string,
  baseUrl?: string
): OpenAILLM;
export function createOpenAILLM(
  configOrApiKey: AgentConfigFile | ModelConfig | string,
  modelName?: string,
  baseUrl?: string
): OpenAILLM {
  // 处理 AgentConfigFile
  if (typeof configOrApiKey === 'object' && 'defaultModel' in configOrApiKey) {
    return new OpenAILLM(configOrApiKey.defaultModel.apiKey, configOrApiKey.defaultModel.model, configOrApiKey.defaultModel.baseUrl);
  }
  // 处理 ModelConfig
  if (typeof configOrApiKey === 'object') {
    return new OpenAILLM(configOrApiKey.apiKey, configOrApiKey.model, configOrApiKey.baseUrl);
  }
  // 处理单独传参
  return new OpenAILLM(configOrApiKey, modelName!, baseUrl);
}
