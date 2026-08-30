/**
 * OpenAI LLM 适配器
 * 实现 LLMClient 接口
 */

import type { LLMClient, Message, Tool, LLMResponse, ToolCall, UsageInfo } from '@agentdevjs/core';
import type { LLMPhase } from '@agentdevjs/core';
import type { CustomHeaderEntry, ThinkingEffort } from '@agentdevjs/core';
import { OPENAI_THINKING_EFFORTS } from '@agentdevjs/core';
import { resolveCustomHeaders } from './custom-headers.js';
import { resolveImageDataUri } from './image-resolver.js';
import { sanitizeToolSchema } from './schema-sanitizer.js';
import OpenAI from 'openai';
import { getRetryDelay, parseRetryAfter, shouldRetry, resolveModelCallPolicy, withDeadline } from '@agentdevjs/core';
import { classifyAndWrapError } from '@agentdevjs/core';
import { initHttpClient } from './http-client.js';
import { emitRetryObservability } from './retry-observability.js';
import { wrapReminder } from './reminder.js';

// 确保 HTTP 客户端基础设施（DNS 缓存、代理、连接池）在首次 fetch 前初始化
let httpClientInitPromise: Promise<void> | null = null;
function ensureHttpClientInitialized() {
  if (!httpClientInitPromise) {
    httpClientInitPromise = initHttpClient();
  }
  return httpClientInitPromise;
}

/**
 * 将内部 Message[] 编译为 OpenAI Chat Completions wire 格式。
 * 与 compileContextForAnthropic / compileContextForOpenAIResponses 对称的导出编译函数。
 *
 * system 消息按 source 二分处理（对齐 compileContextForAnthropic）：
 * - 无 source（agent 系统提示词及经 context.add 注入的同级文档）→ 合并为
 *   开头恰好一条 system 消息。部分 OpenAI 兼容后端（vLLM Qwen chat template 等）
 *   仅接受一条位于开头的 system，多条返回 400 "System message must be at the beginning."。
 * - 有 source（Feature 注入，如 handoff-seed、partial-compact）→ 包 <reminder>
 *   嵌入下一个 user turn（作为文本前缀）；若后续无 user 消息则以独立 user
 *   消息落尾。不插入 assistant/tool 之间，避免破坏 tool_calls 配对。
 */
export function compileChatMessages(
  messages: Message[],
  visionEnabled = false,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const systemPromptParts: string[] = [];
  const compiled: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  let seenFirstUser = false;
  let pendingReminders: string[] = [];

  const flushRemindersAsUserMessage = (): void => {
    if (pendingReminders.length === 0) return;
    compiled.push({ role: 'user', content: pendingReminders.join('\n\n') });
    pendingReminders = [];
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (!seenFirstUser && !m.source) {
        systemPromptParts.push(m.content);
      } else {
        pendingReminders.push(wrapReminder(m.content));
      }
      continue;
    }

    // 中途 system 不能原样放入 Chat Completions messages：兼容性最差的
    // 后端只允许开头的 system。它们会以 user reminder 形式落地，但必须
    // 在下一个 assistant 之前落地，不能一直等到遇到下一个 user；否则
    // 历史提醒会被重新编译到整个上下文的末尾，看起来像最新状态。
    // tool 分支刻意在此之前不 flush，以保持 assistant(tool_calls) 与
    // tool(result) 的相邻配对。
    if (m.role === 'assistant') {
      flushRemindersAsUserMessage();
    }

    if (m.role === 'tool') {
      compiled.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId! });
      // tool 消息附带图片
      if (m.images && m.images.length > 0) {
        if (visionEnabled) {
          // 视觉模式：追加一条 user 消息携带图片
          const parts: OpenAI.Chat.ChatCompletionContentPart[] = [
            { type: 'text', text: `[Tool image result for ${m.toolCallId}]` },
          ];
          for (const img of m.images) {
            const url = resolveImageDataUri(img) || img.source;
            if (url) {
              parts.push({ type: 'image_url', image_url: { url } });
            }
          }
          compiled.push({ role: 'user', content: parts });
        } else {
          // 非视觉模式：降级为文字占位符，追加到 tool 消息后
          const placeholders = m.images
            .map(img => `【Image】${img.source || '(inline image)'}`)
            .join('\n');
          compiled.push({ role: 'user', content: `[Tool image placeholders]\n${placeholders}` });
        }
      }
      continue;
    }

    // assistant 消息携带 toolCalls 时必须序列化为 tool_calls，
    // 否则后续 tool 消息会成为孤儿（严格校验的 OpenAI 兼容后端会返回 400：
    // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"）
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      compiled.push({
        role: 'assistant' as const,
        content: m.content ?? '',
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        })),
      });
      continue;
    }

    // user 消息：待嵌入的 reminder 作为文本前缀拼入 content
    if (m.role === 'user' && m.images && m.images.length > 0) {
      seenFirstUser = true;
      const prefix = pendingReminders.length > 0 ? `${pendingReminders.join('\n\n')}\n\n` : '';
      pendingReminders = [];
      if (visionEnabled) {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        if (m.content) {
          parts.push({ type: 'text', text: `${prefix}${m.content}` });
        } else if (prefix) {
          parts.push({ type: 'text', text: prefix.trimEnd() });
        }
        for (const img of m.images) {
          const url = resolveImageDataUri(img) || img.source;
          if (url) {
            parts.push({ type: 'image_url', image_url: { url } });
          }
        }
        compiled.push({ role: 'user', content: parts });
      } else {
        // 非视觉模式：将图片降级为文字占位符
        const placeholders = m.images
          .map(img => `【Image】${img.source || '(inline image)'}`)
          .join('\n');
        compiled.push({ role: 'user', content: `${prefix}${m.content}\n${placeholders}` });
      }
      continue;
    }

    if (m.role === 'user') {
      seenFirstUser = true;
      if (pendingReminders.length > 0) {
        compiled.push({ role: 'user', content: `${pendingReminders.join('\n\n')}\n\n${m.content}` });
        pendingReminders = [];
      } else {
        compiled.push({ role: 'user', content: m.content });
      }
      continue;
    }

    compiled.push({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam);
  }

  flushRemindersAsUserMessage();

  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPromptParts.length > 0) {
    result.push({ role: 'system', content: systemPromptParts.join('\n\n') });
  }
  result.push(...compiled);
  return result;
}

export class OpenAILLM implements LLMClient {
  private client: OpenAI;
  private _modelName: string;
  private maxTokens?: number;
  private thinkingEffort?: ThinkingEffort;
  private providerOptions?: Record<string, unknown>;
  private customHeaders?: CustomHeaderEntry[];
  private visionEnabled: boolean;
  private initPromise: Promise<void>;
  private maxRetries: number;
  private deadlineMs: number | undefined;

  /** 返回当前 LLM 实例使用的模型名 */
  get modelName(): string { return this._modelName; }

  constructor(
    apiKey: string,
    modelName: string = 'gpt-4o',
    baseUrl?: string,
    maxTokens?: number,
    thinkingEffort?: ThinkingEffort,
    providerOptions?: Record<string, unknown>,
    customHeaders?: CustomHeaderEntry[],
    visionEnabled: boolean = false,
    callPolicy?: { maxRetries?: number; timeoutMs?: number },
  ) {
    const resolved = resolveModelCallPolicy(callPolicy);
    this.maxRetries = resolved.maxRetries;
    this.deadlineMs = resolved.timeoutMs;
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      // 通过自定义 fetch 注入动态请求头，使 uuid / random 模式在每次请求时重新生成
      ...(customHeaders && customHeaders.length > 0
        ? {
            fetch: (input: any, init: any) => {
              init = init || {};
              const headers = new Headers(init.headers);
              for (const [k, v] of Object.entries(resolveCustomHeaders(customHeaders))) {
                headers.set(k, v);
              }
              // The OpenAI SDK has already serialized the body and sets its
              // own Content-Length.  Once a custom fetch forwards that header
              // through Undici's ProxyAgent, Undici 7 rejects it before the
              // request reaches the proxy (UND_ERR_INVALID_ARG).  Let the
              // final fetch implementation calculate it after header
              // injection instead.
              headers.delete('content-length');
              init.headers = headers;
              return globalThis.fetch(input, init);
            },
          }
        : {}),
    });
    this._modelName = modelName;
    this.maxTokens = maxTokens;
    this.thinkingEffort = thinkingEffort;
    this.providerOptions = providerOptions;
    this.customHeaders = customHeaders;
    this.visionEnabled = visionEnabled;
    this.initPromise = ensureHttpClientInitialized();
  }

  /**
   * 聊天 - 核心方法（内部使用流式处理，带重试）
   */
  async chat(messages: Message[], tools: Tool[], options?: { signal?: AbortSignal }): Promise<LLMResponse> {
    // 确保 HTTP 客户端已初始化
    await this.initPromise;
    // 整体时限：deadline 到达以 AbortError 中止，不进入重试
    const signal = withDeadline(options?.signal, this.deadlineMs);
    // 转换消息格式为 OpenAI 格式
    const chatMessages = compileChatMessages(messages, this.visionEnabled);

    // 转换工具格式
    const chatTools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: sanitizeToolSchema(t.parameters),
      },
    }));

    const requestBody = {
      model: this._modelName,
      messages: chatMessages,
      tools: chatTools.length > 0 ? chatTools : undefined,
      stream: true,
      stream_options: { include_usage: true },
      ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
      ...(this.thinkingEffort && OPENAI_THINKING_EFFORTS.includes(this.thinkingEffort)
        ? { reasoning_effort: this.thinkingEffort }
        : {}),
      ...(this.providerOptions ?? {}),
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        // 检查中断信号
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        const stream = await this.client.chat.completions.create(requestBody, {
          signal,
        });

        // ========== 流式处理（内部） ==========

        // 累积内容
        let content = '';
        let reasoning = '';
        let currentPhase: LLMPhase = 'content';

        // 累积 tool_calls
        interface AccumulatedToolCall {
          id: string;
          name: string;
          arguments: string;
        }
        const accumulatedToolCalls: Map<number, AccumulatedToolCall> = new Map();

        // 收集 usage 数据
        let usageInfo: UsageInfo | null = null;

        // 收集 finish_reason
        let finishReason: string | null = null;

        // 迭代流式响应
        for await (const chunk of stream) {
          // 在流式读取中检查中断信号
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          if (chunk.usage) {
            const u = chunk.usage;
            const extendedDetails = u as any;
            let reasoningTokens = 0;
            if (extendedDetails.prompt_tokens_details?.reasoning_tokens) {
              reasoningTokens += extendedDetails.prompt_tokens_details.reasoning_tokens;
            }
            if (extendedDetails.completion_tokens_details?.reasoning_tokens) {
              reasoningTokens += extendedDetails.completion_tokens_details.reasoning_tokens;
            }

            usageInfo = {
              inputTokens: u.prompt_tokens || 0,
              outputTokens: u.completion_tokens || 0,
              totalTokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
              ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
            };
          }

          const delta = chunk.choices[0]?.delta;
          if (!delta) {
            continue;
          }

          const rawDelta = delta as { reasoning_content?: string; reasoning?: string; content?: string | null };
          // reasoning_content（DeepSeek/GLM 等）与 reasoning（OpenRouter 等网关）是两种
          // 后端扩展字段，都识别为思考增量。reasoning 与 content 独立累积：过渡 chunk
          // 可能同包携带两者（reasoning 尾巴 + 正文开头），else-if 结构会永久丢弃正文开头片段
          const reasoningDelta = rawDelta.reasoning_content || rawDelta.reasoning;
          if (reasoningDelta) {
            currentPhase = 'thinking';
            reasoning += reasoningDelta;
          }
          if (delta.content) {
            currentPhase = 'content';
            content += delta.content;
          }

          if (delta.tool_calls) {
            currentPhase = 'tool_calling';
            for (const toolCall of delta.tool_calls) {
              // 兼容省略 index 的 OpenAI 兼容实现（部分网关非并行场景不回填 index）：
              // 静默丢弃会导致工具调用整体丢失，表现为"会话没有工具调用就被打断"。
              // 带 id 的增量优先续写同 id 条目，否则开启新调用；不带 id 的增量续写最近条目。
              let index = toolCall.index;
              if (index === undefined || index === null) {
                if (toolCall.id) {
                  const existingIndex = Array.from(accumulatedToolCalls.entries())
                    .find(([, v]) => v.id === toolCall.id)?.[0];
                  index = existingIndex ?? accumulatedToolCalls.size;
                } else {
                  index = Math.max(accumulatedToolCalls.size - 1, 0);
                }
              }

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

          try {
            const { emitNotification, createLLMCharCount } = await import('@agentdevjs/core');
            // 各 phase 独立计数：正文阶段不应延续思考阶段的累计值
            const phaseCharCount = currentPhase === 'thinking' ? reasoning.length : content.length;
            if (phaseCharCount > 0 || accumulatedToolCalls.size > 0) {
              const toolNames = Array.from(accumulatedToolCalls.values()).map(tc => tc.name).filter(Boolean);
              emitNotification(createLLMCharCount(phaseCharCount, currentPhase, {
                thinkingChars: reasoning.length,
                contentChars: content.length,
                toolCallCount: accumulatedToolCalls.size,
                ...(toolNames.length > 0 ? { streamToolNames: toolNames } : {}),
              }));
            }
          } catch {
            // 通知模块不可用，忽略
          }

          if (chunk.choices[0]?.finish_reason) {
            // 仅记录，不立即中断迭代：部分网关 finish_reason 先行、增量殿后，
            // 提前 break 会丢失尾部 tool_calls 增量与 usage chunk。
            // 规范网关在 [DONE] 后迭代器自然结束，无额外等待。
            finishReason = chunk.choices[0].finish_reason;
          }
        }

        // 构建最终的 tool_calls 数组
        let toolCalls: ToolCall[] | undefined;
        if (accumulatedToolCalls.size > 0) {
          toolCalls = Array.from(accumulatedToolCalls.values()).map(tc => {
            let parsedArgs: Record<string, any> = {};
            const argStr = tc.arguments.trim();
            if (argStr) {
              try {
                parsedArgs = JSON.parse(argStr);
              } catch {
                // JSON 不完整（通常是 max_tokens 截断导致）
                // 返回空对象，由 react-loop 的截断防御处理
                console.warn(
                  `[OpenAI] Failed to parse tool arguments for tool "${tc.name}". ` +
                  `Arguments length: ${argStr.length}, preview: ${argStr.slice(0, 200)}`,
                );
              }
            }
            return {
              id: tc.id,
              name: tc.name,
              arguments: parsedArgs,
            };
          });
        }

        return {
          content,
          toolCalls,
          reasoning,
          ...(usageInfo ? { usage: usageInfo } : {}),
          stopReason: finishReason,
        };
      } catch (error) {
        // 中断错误不重试，直接传播
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        // AbortError from fetch/signal
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }

        // OpenAI SDK 错误对象上通常有 status 和 headers
        const status = (error as any)?.status as number | undefined;
        if (attempt <= this.maxRetries && shouldRetry(error, status)) {
          const retryAfterMs = parseRetryAfter((error as any)?.headers);
          const delayMs = getRetryDelay(attempt, retryAfterMs);
          await emitRetryObservability({
            attempt,
            maxRetries: this.maxRetries,
            delayMs,
            signal,
            error,
            status,
          });
          continue;
        }
        // 重试耗尽或不可重试 → 分类包装后抛出
        throw classifyAndWrapError(error, status);
      }
    }

    // 理论上不会到这里
    throw new Error('OpenAI API call failed after all retries');
  }
}

import type { ModelConfig, AgentConfigFile } from '@agentdevjs/core';

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
    return new OpenAILLM(
      configOrApiKey.defaultModel.apiKey,
      configOrApiKey.defaultModel.model,
      configOrApiKey.defaultModel.baseUrl,
      configOrApiKey.defaultModel.maxTokens,
      configOrApiKey.defaultModel.thinkingEffort,
      configOrApiKey.defaultModel.providerOptions,
      configOrApiKey.defaultModel.customHeaders,
      configOrApiKey.defaultModel.vision ?? false,
      { maxRetries: configOrApiKey.defaultModel.maxRetries, timeoutMs: configOrApiKey.defaultModel.timeoutMs },
    );
  }
  // 处理 ModelConfig
  if (typeof configOrApiKey === 'object') {
    return new OpenAILLM(
      configOrApiKey.apiKey,
      configOrApiKey.model,
      configOrApiKey.baseUrl,
      configOrApiKey.maxTokens,
      configOrApiKey.thinkingEffort,
      configOrApiKey.providerOptions,
      configOrApiKey.customHeaders,
      configOrApiKey.vision ?? false,
      { maxRetries: configOrApiKey.maxRetries, timeoutMs: configOrApiKey.timeoutMs },
    );
  }
  // 处理单独传参
  return new OpenAILLM(configOrApiKey, modelName!, baseUrl);
}
