/**
 * OpenAI Responses LLM 适配器
 *
 * 只负责把框架的 Message / Tool 编译为 Responses 输入，
 * 再把 Responses 输出收敛回 LLMResponse。
 */

import OpenAI from 'openai';
import type { AgentConfigFile, ModelConfig, CustomHeaderEntry } from '../core/config.js';
import type { LLMClient, LLMResponse, Message, Tool, ToolCall, UsageInfo, ThinkingBlock, ImageInput } from '../core/types.js';
import { resolveCustomHeaders } from './custom-headers.js';
import { resolveImageDataUri } from './image-resolver.js';
import { DEFAULT_MAX_RETRIES, getRetryDelay, parseRetryAfter, shouldRetry, sleep } from './retry.js';
import { classifyAndWrapError } from './api-errors.js';
import { initHttpClient } from './http-client.js';

// 确保 HTTP 客户端基础设施（DNS 缓存、代理、连接池）在首次 fetch 前初始化
let httpClientInitPromise: Promise<void> | null = null;
function ensureHttpClientInitialized() {
  if (!httpClientInitPromise) {
    httpClientInitPromise = initHttpClient();
  }
  return httpClientInitPromise;
}

type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: any[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: 'auto';
  max_output_tokens?: number;
  parallel_tool_calls?: boolean;
  reasoning?: Record<string, unknown>;
  previous_response_id?: string;
  store?: boolean;
  text?: Record<string, unknown>;
  include?: Array<string>;
  [key: string]: unknown;
};

export type OpenAIResponsesProfile = 'standard' | 'codex';

const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful assistant.';

type ResponsesSnapshot = {
  output?: any[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  status?: string;
  incomplete_details?: { reason?: string } | null;
};

interface AccumulatedFunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}

interface AccumulatedReasoning {
  id: string;
  summary: string[];
}

export class OpenAIResponsesLLM implements LLMClient {
  private client: OpenAI;
  private _modelName: string;
  private maxTokens?: number;
  private thinkingBudgetTokens?: number;
  private providerOptions?: Record<string, unknown>;
  private customHeaders?: CustomHeaderEntry[];
  private visionEnabled: boolean;
  private responsesProfile: OpenAIResponsesProfile;
  private initPromise: Promise<void>;

  /** 返回当前 LLM 实例使用的模型名 */
  get modelName(): string { return this._modelName; }

  constructor(
    apiKey: string,
    modelName: string = 'gpt-4o',
    baseUrl?: string,
    maxTokens?: number,
    thinkingBudgetTokens?: number,
    providerOptions?: Record<string, unknown>,
    customHeaders?: CustomHeaderEntry[],
    visionEnabled: boolean = false,
    responsesProfile: OpenAIResponsesProfile = 'standard',
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      ...(customHeaders && customHeaders.length > 0
        ? {
            fetch: (input: any, init: any) => {
              init = init || {};
              const headers = new Headers(init.headers);
              for (const [k, v] of Object.entries(resolveCustomHeaders(customHeaders))) {
                headers.set(k, v);
              }
              init.headers = headers;
              return globalThis.fetch(input, init);
            },
          }
        : {}),
    });
    this._modelName = modelName;
    this.maxTokens = maxTokens;
    this.thinkingBudgetTokens = thinkingBudgetTokens;
    this.providerOptions = providerOptions;
    this.customHeaders = customHeaders;
    this.visionEnabled = visionEnabled;
    this.responsesProfile = responsesProfile;
    this.initPromise = ensureHttpClientInitialized();
  }

  async chat(messages: Message[], tools: Tool[], options?: { signal?: AbortSignal }): Promise<LLMResponse> {
    await this.initPromise;

    const compiled = compileContextForOpenAIResponses(messages, tools, {
      modelName: this._modelName,
      maxTokens: this.maxTokens,
      thinkingBudgetTokens: this.thinkingBudgetTokens,
      providerOptions: this.providerOptions,
      visionEnabled: this.visionEnabled,
      responsesProfile: this.responsesProfile,
    });
    let preferNonStreaming = false;

    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES + 1; attempt++) {
      let sawAnyStreamEvent = false;
      try {
        if (options?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        if (preferNonStreaming) {
          return await this.createResponsesCompletion(compiled, options);
        }

        const stream = this.client.responses.stream(
          {
            ...compiled,
            stream: true,
          } as any,
          { signal: options?.signal },
        );

        let content = '';
        let reasoning = '';
        let charCount = 0;
        let stopReason: string | null = null;
        let usageInfo: UsageInfo | null = null;
        let completedSnapshot: ResponsesSnapshot | null = null;
        let completedText = '';

        const functionCalls = new Map<string, AccumulatedFunctionCall>();
        const reasoningItems = new Map<string, AccumulatedReasoning>();

        for await (const event of stream) {
          sawAnyStreamEvent = true;
          if (options?.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          switch (event.type) {
            case 'response.output_text.delta': {
              const delta = String(event.delta || '');
              if (delta) {
                content += delta;
                charCount += delta.length;
              }
              break;
            }
            case 'response.output_text.done': {
              completedText = String(event.text || completedText || '');
              break;
            }
            case 'response.function_call_arguments.delta': {
              const key = String(event.item_id || event.output_index);
              if (!functionCalls.has(key)) {
                functionCalls.set(key, {
                  call_id: '',
                  name: '',
                  arguments: '',
                });
              }
              functionCalls.get(key)!.arguments += String(event.delta || '');
              break;
            }
            case 'response.function_call_arguments.done': {
              const key = String(event.item_id || event.output_index);
              if (!functionCalls.has(key)) {
                functionCalls.set(key, {
                  call_id: '',
                  name: '',
                  arguments: '',
                });
              }
              functionCalls.get(key)!.arguments = String(event.arguments || functionCalls.get(key)!.arguments || '');
              break;
            }
            case 'response.output_item.added':
            case 'response.output_item.done': {
              const item = event.item || {};
              if (item.type === 'function_call') {
                const key = String(item.id || event.output_index);
                functionCalls.set(key, {
                  call_id: String(item.call_id || ''),
                  name: String(item.name || ''),
                  arguments: String(item.arguments || ''),
                });
              } else if (item.type === 'reasoning') {
                recordReasoningItem(reasoningItems, item);
              } else if (item.type === 'message' && event.type === 'response.output_item.done') {
                completedText = extractOutputMessageText(item) || completedText;
              }
              break;
            }
            case 'response.reasoning_summary.delta':
            case 'response.reasoning_summary_text.delta': {
              const key = String(event.item_id || event.output_index);
              if (!reasoningItems.has(key)) {
                reasoningItems.set(key, { id: String(event.item_id || ''), summary: [] });
              }
              const delta = extractTextDelta(event.delta);
              if (delta) {
                const entry = reasoningItems.get(key)!;
                if (entry.summary.length === 0) {
                  entry.summary.push(delta);
                } else {
                  entry.summary[entry.summary.length - 1] += delta;
                }
                reasoning += delta;
                charCount += delta.length;
              }
              break;
            }
            case 'response.reasoning_summary.done': {
              const key = String(event.item_id || event.output_index);
              const text = String(event.text || '');
              if (!reasoningItems.has(key)) {
                reasoningItems.set(key, { id: String(event.item_id || ''), summary: [] });
              }
              const entry = reasoningItems.get(key)!;
              if (text) {
                entry.summary = [text];
                reasoning += text;
                charCount += text.length;
              }
              break;
            }
            case 'response.reasoning_summary_text.done': {
              const key = String(event.item_id || event.output_index);
              const text = String(event.text || '');
              if (!reasoningItems.has(key)) {
                reasoningItems.set(key, { id: String(event.item_id || ''), summary: [] });
              }
              const entry = reasoningItems.get(key)!;
              if (text) {
                entry.summary = [text];
                reasoning += text;
                charCount += text.length;
              }
              break;
            }
            case 'response.completed': {
              completedSnapshot = event.response as ResponsesSnapshot | null;
              stopReason = mapResponseStatusToStopReason(completedSnapshot);
              break;
            }
            case 'response.failed': {
              completedSnapshot = event.response as ResponsesSnapshot | null;
              stopReason = 'failed';
              break;
            }
            case 'response.incomplete': {
              completedSnapshot = event.response as ResponsesSnapshot | null;
              stopReason = mapResponseStatusToStopReason(completedSnapshot);
              break;
            }
            default:
              break;
          }

          try {
            const { emitNotification, createLLMCharCount } = await import('../core/notification.js');
            const currentPhase: 'thinking' | 'content' | 'tool_calling' = functionCalls.size > 0
              ? 'tool_calling'
              : reasoning
                ? 'thinking'
                : 'content';
            if (charCount > 0 || functionCalls.size > 0) {
              emitNotification(createLLMCharCount(charCount, currentPhase));
            }
          } catch {
            // Ignore notification failures.
          }
        }

        const parsedSnapshot = completedSnapshot ? parseOpenAIResponsesSnapshot(completedSnapshot) : null;
        if (parsedSnapshot?.usage) {
          usageInfo = parsedSnapshot.usage;
        }

        const parsedToolCalls = parsedSnapshot?.toolCalls?.length
          ? parsedSnapshot.toolCalls
          : finalizeToolCalls(functionCalls);
        const parsedThinkingBlocks = parsedSnapshot?.thinkingBlocks?.length
          ? parsedSnapshot.thinkingBlocks
          : finalizeThinkingBlocks(reasoningItems);
        // ChatGPT's Codex backend currently emits the actual message through
        // stream events but returns response.completed with output: []. Never
        // let that sparse terminal snapshot erase text already received.
        const finalContent = parsedSnapshot?.content || content || completedText;
        const finalReasoning = parsedSnapshot?.reasoning || reasoning;
        const finalStopReason = parsedSnapshot?.stopReason ?? stopReason;

        return {
          content: finalContent,
          ...(parsedToolCalls.length > 0 ? { toolCalls: parsedToolCalls } : {}),
          ...(finalReasoning ? { reasoning: finalReasoning } : {}),
          ...(parsedThinkingBlocks.length > 0 ? { thinkingBlocks: parsedThinkingBlocks } : {}),
          ...(usageInfo ? { usage: usageInfo } : {}),
          stopReason: finalStopReason,
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }

        if (isEmptyResponsesStreamError(error) && !sawAnyStreamEvent) {
          preferNonStreaming = true;
          try {
            return await this.createResponsesCompletion(compiled, options);
          } catch (fallbackError) {
            if (fallbackError instanceof DOMException && fallbackError.name === 'AbortError') {
              throw fallbackError;
            }
            if (fallbackError instanceof Error && fallbackError.name === 'AbortError') {
              throw fallbackError;
            }

            const fallbackStatus = (fallbackError as any)?.status as number | undefined;
            if (attempt <= DEFAULT_MAX_RETRIES && shouldRetry(fallbackError, fallbackStatus)) {
              const retryAfterMs = parseRetryAfter((fallbackError as any)?.headers);
              const delayMs = getRetryDelay(attempt, retryAfterMs);
              await sleep(delayMs);
              continue;
            }

            throw classifyAndWrapError(fallbackError, fallbackStatus);
          }
        }

        const status = (error as any)?.status as number | undefined;
        if (attempt <= DEFAULT_MAX_RETRIES && shouldRetry(error, status)) {
          const retryAfterMs = parseRetryAfter((error as any)?.headers);
          const delayMs = getRetryDelay(attempt, retryAfterMs);
          await sleep(delayMs);
          continue;
        }

        throw classifyAndWrapError(error, status);
      }
    }

    throw new Error('OpenAI Responses API call failed after all retries');
  }

  private async createResponsesCompletion(
    compiled: ResponsesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LLMResponse> {
    const response = await this.client.responses.create(compiled as any, { signal: options?.signal } as any);
    const parsedSnapshot = parseOpenAIResponsesSnapshot(response as ResponsesSnapshot);

    return {
      content: parsedSnapshot.content,
      ...(parsedSnapshot.toolCalls.length > 0 ? { toolCalls: parsedSnapshot.toolCalls } : {}),
      ...(parsedSnapshot.reasoning ? { reasoning: parsedSnapshot.reasoning } : {}),
      ...(parsedSnapshot.thinkingBlocks.length > 0 ? { thinkingBlocks: parsedSnapshot.thinkingBlocks } : {}),
      ...(parsedSnapshot.usage ? { usage: parsedSnapshot.usage } : {}),
      stopReason: parsedSnapshot.stopReason,
    };
  }
}

export interface CompileOpenAIResponsesOptions {
  modelName?: string;
  maxTokens?: number;
  thinkingBudgetTokens?: number;
  providerOptions?: Record<string, unknown>;
  visionEnabled?: boolean;
  responsesProfile?: OpenAIResponsesProfile;
}

export function compileContextForOpenAIResponses(
  messages: Message[],
  tools: Tool[],
  options: CompileOpenAIResponsesOptions = {},
): ResponsesRequest {
  const input: any[] = [];
  const responsesProfile = options.responsesProfile ?? 'standard';
  const codexInstructionParts: string[] = [];
  let reachedConversation = false;

  for (const message of messages) {
    if (!message) continue;

    if (message.role === 'system') {
      if (responsesProfile === 'codex' && !reachedConversation && !message.source) {
        const instruction = String(message.content ?? '').trim();
        if (instruction) codexInstructionParts.push(instruction);
        continue;
      }

      input.push({
        type: 'message',
        // Feature-injected system messages are runtime reminders rather than
        // part of the stable agent identity on the Codex backend.
        role: responsesProfile === 'codex' && message.source ? 'user' : 'system',
        content: [
          {
            type: 'input_text',
            text: String(message.content ?? ''),
          },
        ],
      });
      continue;
    }

    reachedConversation = true;

    if (message.role === 'user') {
      const visionEnabled = options.visionEnabled ?? false;
      let textContent = String(message.content ?? '');

      // 处理图片
      if (message.images && message.images.length > 0) {
        if (visionEnabled) {
          // 视觉模式：生成 input_image 内容块
          const contentParts: any[] = [
            { type: 'input_text', text: textContent },
          ];
          for (const img of message.images) {
            const url = resolveImageDataUri(img) || img.source;
            if (url) {
              contentParts.push({ type: 'input_image', image_url: url, detail: 'auto' });
            }
          }
          input.push({ type: 'message', role: 'user', content: contentParts });
          continue;
        }
        // 非视觉模式：降级为文字占位符
        const placeholders = message.images
          .map(img => `【Image】${img.source || '(inline image)'}`)
          .join('\n');
        textContent = `${textContent}\n${placeholders}`;
      }

      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: textContent }],
      });
      continue;
    }

    if (message.role === 'assistant') {
      const assistantItems = compileAssistantMessageToResponsesItems(message, responsesProfile);
      input.push(...assistantItems);
      continue;
    }

    if (message.role === 'tool') {
      if (!message.toolCallId) {
        throw new Error('OpenAI Responses compilation requires tool messages to include toolCallId');
      }
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: String(message.content ?? ''),
      });
      continue;
    }

    input.push({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: String(message.content ?? ''),
        },
      ],
    });
  }

  const compiledTools = tools.length > 0
    ? tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: normalizeToolParameters(tool.parameters),
        strict: false,
      }))
    : undefined;

  const request: ResponsesRequest = {
    model: options.modelName || 'gpt-4o',
    input,
    ...(compiledTools ? { tools: compiledTools } : {}),
    ...(responsesProfile !== 'codex'
      && typeof options.maxTokens === 'number'
      && Number.isFinite(options.maxTokens)
      && options.maxTokens > 0
      ? { max_output_tokens: options.maxTokens }
      : {}),
    ...(tools.length > 0
      ? {
          parallel_tool_calls: true,
          ...(responsesProfile === 'codex' ? { tool_choice: 'auto' as const } : {}),
        }
      : {}),
    ...(typeof options.thinkingBudgetTokens === 'number' && options.thinkingBudgetTokens > 0
      ? {
          reasoning: {
            effort: mapThinkingBudgetToEffort(options.thinkingBudgetTokens),
            summary: 'auto',
          },
        }
      : {}),
    ...(options.providerOptions ?? {}),
  };

  if (responsesProfile === 'codex') {
    // ChatGPT's Codex endpoint uses a stricter Responses contract than the
    // public API. Keep these fields runtime-owned so generic provider options
    // cannot accidentally turn a valid OAuth request back into a 400.
    request.model = options.modelName || 'gpt-4o';
    request.instructions = codexInstructionParts.join('\n\n').trim() || DEFAULT_CODEX_INSTRUCTIONS;
    request.input = input;
    request.store = false;
  }

  return request;
}

function compileAssistantMessageToResponsesItems(
  message: Message,
  responsesProfile: OpenAIResponsesProfile,
): any[] {
  const items: any[] = [];
  const reasoningParts: string[] = [];

  if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    reasoningParts.push(message.reasoning.trim());
  }

  if (Array.isArray(message.thinkingBlocks)) {
    for (const block of message.thinkingBlocks) {
      if (block?.thinking?.trim()) {
        reasoningParts.push(block.thinking.trim());
      }
    }
  }

  // Codex reasoning summaries are output-only display data. Without the
  // server-issued encrypted_content they cannot be replayed as input items;
  // synthetic id/status fields cause a 400 on the next turn.
  if (reasoningParts.length > 0 && responsesProfile !== 'codex') {
    items.push({
      type: 'reasoning',
      id: `reasoning-${items.length}`,
      summary: reasoningParts.map((text) => ({
        type: 'summary_text',
        text,
      })),
      status: 'completed',
    });
  }

  if (typeof message.content === 'string' && message.content.trim()) {
    items.push({
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: message.content,
          ...(responsesProfile === 'standard' ? { annotations: [] } : {}),
        },
      ],
    });
  }

  if (Array.isArray(message.toolCalls)) {
    for (const toolCall of message.toolCalls) {
      items.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments ?? {}),
      });
    }
  }

  if (items.length === 0 && responsesProfile === 'standard') {
    items.push({
      type: 'message',
      role: 'assistant',
      content: [],
    });
  }

  return items;
}

function parseOpenAIResponsesSnapshot(snapshot: ResponsesSnapshot): {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  thinkingBlocks: ThinkingBlock[];
  usage?: UsageInfo;
  stopReason: string | null;
} {
  const output = Array.isArray(snapshot?.output) ? snapshot.output : [];
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          contentParts.push(part.text);
        }
      }
      continue;
    }

    if (item.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || ''),
        name: String(item.name || ''),
        arguments: parseToolArguments(String(item.arguments || ''), item.name),
      });
      continue;
    }

    if (item.type === 'reasoning') {
      const summaryText = Array.isArray(item.summary)
        ? item.summary.map((part: any) => String(part?.text || '')).filter(Boolean).join('\n').trim()
        : '';
      if (summaryText) {
        reasoningParts.push(summaryText);
        thinkingBlocks.push({
          signature: String(item.id || ''),
          thinking: summaryText,
        });
      }
    }
  }

  const usage = snapshot.usage
    ? {
        inputTokens: Number(snapshot.usage.input_tokens || 0),
        outputTokens: Number(snapshot.usage.output_tokens || 0),
        totalTokens: Number(snapshot.usage.total_tokens || 0),
        ...(Number(snapshot.usage.input_tokens_details?.cached_tokens || 0) > 0
          ? { cacheReadTokens: Number(snapshot.usage.input_tokens_details?.cached_tokens || 0) }
          : {}),
        ...(Number(snapshot.usage.output_tokens_details?.reasoning_tokens || 0) > 0
          ? { reasoningTokens: Number(snapshot.usage.output_tokens_details?.reasoning_tokens || 0) }
          : {}),
      }
    : undefined;

  const content = typeof snapshot.output_text === 'string' && snapshot.output_text.trim()
    ? snapshot.output_text
    : contentParts.join('');

  return {
    content,
    toolCalls,
    ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join('\n') } : {}),
    thinkingBlocks,
    ...(usage ? { usage } : {}),
    stopReason: mapResponseStatusToStopReason(snapshot),
  };
}

function finalizeToolCalls(functionCalls: Map<string, AccumulatedFunctionCall>): ToolCall[] {
  return Array.from(functionCalls.values())
    .map((call) => ({
      id: call.call_id || call.name || `tool-${Math.random().toString(36).slice(2, 8)}`,
      name: call.name,
      arguments: parseToolArguments(call.arguments, call.name),
    }))
    .filter((call) => Boolean(call.name));
}

function finalizeThinkingBlocks(reasoningItems: Map<string, AccumulatedReasoning>): ThinkingBlock[] {
  return Array.from(reasoningItems.values())
    .map((item) => ({
      signature: item.id,
      thinking: item.summary.join('\n').trim(),
    }))
    .filter((block) => Boolean(block.signature) && Boolean(block.thinking));
}

function recordReasoningItem(
  reasoningItems: Map<string, AccumulatedReasoning>,
  item: { id?: string; summary?: Array<{ text?: string }> },
): void {
  const id = String(item?.id || '');
  if (!id) return;
  const summary = Array.isArray(item.summary)
    ? item.summary.map((part) => String(part?.text || '')).filter(Boolean)
    : [];
  if (!reasoningItems.has(id)) {
    reasoningItems.set(id, { id, summary: [] });
  }
  const entry = reasoningItems.get(id)!;
  if (summary.length > 0) {
    entry.summary = summary;
  }
}

function extractTextDelta(delta: unknown): string {
  if (typeof delta === 'string') return delta;
  if (delta && typeof delta === 'object' && 'text' in delta && typeof (delta as any).text === 'string') {
    return (delta as any).text;
  }
  return '';
}

function extractOutputMessageText(item: any): string {
  if (!Array.isArray(item?.content)) return '';
  return item.content
    .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('');
}

function mapThinkingBudgetToEffort(thinkingBudgetTokens: number): 'low' | 'medium' | 'high' {
  if (thinkingBudgetTokens >= 100000) return 'high';
  if (thinkingBudgetTokens >= 10000) return 'medium';
  return 'low';
}

function normalizeToolParameters(parameters: Record<string, any> | undefined): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object') {
    return { type: 'object', properties: {} };
  }
  return parameters;
}

function parseToolArguments(raw: string, toolName?: string): Record<string, any> {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    // fall through
  }

  console.warn(
    `[OpenAI Responses] Failed to parse tool arguments${toolName ? ` for tool "${toolName}"` : ''}. ` +
    `Input length: ${trimmed.length}, preview: ${trimmed.slice(0, 200)}`,
  );
  return {};
}

function isEmptyResponsesStreamError(error: unknown): boolean {
  return error instanceof Error && /request ended without sending any events/i.test(error.message);
}

function mapResponseStatusToStopReason(snapshot: ResponsesSnapshot | null): string | null {
  if (!snapshot) return null;
  if (snapshot.status === 'incomplete') {
    const reason = snapshot.incomplete_details?.reason || 'incomplete';
    return reason === 'max_output_tokens' ? 'max_tokens' : reason;
  }
  if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
    return snapshot.status;
  }
  if (snapshot.status === 'completed') {
    if (Array.isArray(snapshot.output) && snapshot.output.some((item) => item?.type === 'function_call')) {
      return 'tool_calls';
    }
    return 'stop';
  }
  return snapshot.status || null;
}

export function createOpenAIResponsesLLM(config: AgentConfigFile): OpenAIResponsesLLM;
export function createOpenAIResponsesLLM(modelConfig: ModelConfig): OpenAIResponsesLLM;
export function createOpenAIResponsesLLM(
  apiKey: string,
  modelName: string,
  baseUrl?: string,
): OpenAIResponsesLLM;
export function createOpenAIResponsesLLM(
  configOrApiKey: AgentConfigFile | ModelConfig | string,
  modelName?: string,
  baseUrl?: string,
): OpenAIResponsesLLM {
  if (typeof configOrApiKey === 'object' && 'defaultModel' in configOrApiKey) {
    return new OpenAIResponsesLLM(
      configOrApiKey.defaultModel.apiKey,
      configOrApiKey.defaultModel.model,
      configOrApiKey.defaultModel.baseUrl,
      configOrApiKey.defaultModel.maxTokens,
      configOrApiKey.defaultModel.thinkingBudgetTokens,
      configOrApiKey.defaultModel.providerOptions,
      configOrApiKey.defaultModel.customHeaders,
      configOrApiKey.defaultModel.vision ?? false,
      configOrApiKey.defaultModel.responsesProfile ?? 'standard',
    );
  }

  if (typeof configOrApiKey === 'object') {
    return new OpenAIResponsesLLM(
      configOrApiKey.apiKey,
      configOrApiKey.model,
      configOrApiKey.baseUrl,
      configOrApiKey.maxTokens,
      configOrApiKey.thinkingBudgetTokens,
      configOrApiKey.providerOptions,
      configOrApiKey.customHeaders,
      configOrApiKey.vision ?? false,
      configOrApiKey.responsesProfile ?? 'standard',
    );
  }

  return new OpenAIResponsesLLM(configOrApiKey, modelName!, baseUrl);
}
