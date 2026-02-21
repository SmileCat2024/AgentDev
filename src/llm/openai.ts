/**
 * OpenAI LLM 适配器
 * 实现 LLMClient 接口
 */

import type { LLMClient, Message, Tool, LLMResponse, ToolCall } from '../core/types.js';
import type { LLMPhase } from '../core/types.js';
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
   * 聊天 - 核心方法（内部使用流式处理）
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

    // ========== 流式处理（内部） ==========
    const stream = await this.client.chat.completions.create({
      model: this.modelName,
      messages: chatMessages,
      tools: chatTools.length > 0 ? chatTools : undefined,
      stream: true,
    });

    // 累积内容
    let content = '';
    let reasoning = '';
    let currentPhase: LLMPhase = 'content';
    let charCount = 0;

    // 累积 tool_calls
    // tool_calls 在流中是增量的，需要合并
    interface AccumulatedToolCall {
      id: string;
      name: string;
      arguments: string;
    }
    const accumulatedToolCalls: Map<number, AccumulatedToolCall> = new Map();

    // 迭代流式响应
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (!delta) continue;

      // 判断当前阶段并累积内容
      // 使用类型断言处理扩展字段 reasoning_content（GLM-4.7 等模型支持）
      const rawDelta = delta as { reasoning_content?: string; content?: string | null };
      if (rawDelta.reasoning_content) {
        currentPhase = 'thinking';
        reasoning += rawDelta.reasoning_content;
        charCount += rawDelta.reasoning_content.length;
      } else if (delta.content) {
        currentPhase = 'content';
        content += delta.content;
        charCount += delta.content.length;
      }

      // 处理 tool_calls（增量累积）
      if (delta.tool_calls) {
        currentPhase = 'tool_calling';
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;
          if (index === undefined) continue;

          if (!accumulatedToolCalls.has(index)) {
            accumulatedToolCalls.set(index, {
              id: toolCall.id || '',
              name: toolCall.function?.name || '',
              arguments: toolCall.function?.arguments || '',
            });
          } else {
            const accumulated = accumulatedToolCalls.get(index)!;
            if (toolCall.id) accumulated.id = toolCall.id;
            if (toolCall.function?.name) accumulated.name += toolCall.function.name;
            if (toolCall.function?.arguments) accumulated.arguments += toolCall.function.arguments;
          }
        }
      }

      // 发送字符计数通知（每 100ms 最多一次，由 emitNotification 节流）
      try {
        const { emitNotification, createLLMCharCount } = await import('../core/notification.js');
        if (charCount > 0 || accumulatedToolCalls.size > 0) {
          emitNotification(createLLMCharCount(charCount, currentPhase));
        }
      } catch {
        // 通知模块不可用，忽略
      }

      // 检查是否完成
      if (chunk.choices[0]?.finish_reason) {
        break;
      }
    }

    // 构建最终的 tool_calls 数组
    let toolCalls: ToolCall[] | undefined;
    if (accumulatedToolCalls.size > 0) {
      toolCalls = Array.from(accumulatedToolCalls.values()).map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.parse(tc.arguments),
      }));
    }

    return {
      content,
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
