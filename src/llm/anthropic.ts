import type { AgentConfigFile, ModelConfig, CustomHeaderEntry } from '../core/config.js';
import { resolveCustomHeaders } from './custom-headers.js';
import type { LLMClient, LLMResponse, LLMChatOptions, Message, ThinkingBlock, Tool, ToolCall, UsageInfo, ImageInput } from '../core/types.js';
import type { LLMPhase } from '../core/types.js';
import { DEFAULT_MAX_RETRIES, getRetryDelay, parseRetryAfter, shouldRetry, sleep } from './retry.js';
import { classifyAndWrapError, ClassifiedAPIError } from './api-errors.js';
import { initHttpClient } from './http-client.js';
import { resolveImageBase64 } from './image-resolver.js';

// 确保 HTTP 客户端基础设施（DNS 缓存、代理、连接池）在首次 fetch 前初始化
let httpClientInitPromise: Promise<void> | null = null;
function ensureHttpClientInitialized() {
  if (!httpClientInitPromise) {
    httpClientInitPromise = initHttpClient();
  }
  return httpClientInitPromise;
}

type AnthropicTextBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type AnthropicThinkingBlock = {
  type: 'thinking';
  thinking: string;
  signature: string;
};

type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
};

type AnthropicImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
};

type AnthropicContentBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolResultBlock | AnthropicToolUseBlock | AnthropicImageBlock;

interface AnthropicRequestMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: AnthropicContentBlock;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  message?: {
    id?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface CompiledAnthropicRequest {
  system?: AnthropicTextBlock[];
  messages: AnthropicRequestMessage[];
  tools?: AnthropicToolDef[];
}

interface AnthropicCompatErrorPayload {
  code?: number;
  msg?: string;
  message?: string;
  success?: boolean;
}

interface PendingToolUse {
  id: string;
  name: string;
  inputJson: string;
}

interface PendingThinkingBlock {
  thinking: string;
  signature: string;
}

interface AnthropicContextManagementConfig {
  edits: Array<{
    type: 'clear_thinking_20251015';
    keep: {
      type: 'thinking_turns';
      value: number;
    } | 'all';
  }>;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_THINKING_KEEP_TURNS = 5;
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

/**
 * Minimum output tokens reserved for actual response content (text + tool calls)
 * when thinking is enabled. Without this, the model could consume the entire
 * max_tokens budget on thinking alone and produce empty content.
 */
const MIN_OUTPUT_TOKENS_WHEN_THINKING = 4096;

export class AnthropicLLM implements LLMClient {
  private initPromise: Promise<void>;

  /** 返回当前 LLM 实例使用的模型名 */
  get modelName(): string { return this._modelName; }

  constructor(
    private readonly apiKey: string,
    private readonly _modelName: string = 'claude-sonnet-4-5-20250929',
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly maxTokens: number = DEFAULT_MAX_TOKENS,
    private readonly thinkingBudgetTokens?: number,
    private readonly thinkingKeepTurns: number = DEFAULT_THINKING_KEEP_TURNS,
    private readonly customHeaders?: CustomHeaderEntry[],
    private readonly visionEnabled: boolean = false,
  ) {
    this.initPromise = ensureHttpClientInitialized();
  }

  async chat(messages: Message[], tools: Tool[], options?: LLMChatOptions): Promise<LLMResponse> {
    // 确保 HTTP 客户端已初始化
    await this.initPromise;
    const compiled = compileContextForAnthropic(messages, tools, this.visionEnabled);
    const noStream = options?.noStream === true;

    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES + 1; attempt++) {
      let response: Response | undefined;
      try {
        // 检查中断信号
        if (options?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        // Compute effective token budgets to satisfy the Anthropic API constraint:
        // budget_tokens must be strictly less than max_tokens.
        // When thinking is enabled, ensure max_tokens has room for actual output
        // by scaling the thinking budget DOWN to fit, never inflating max_tokens
        // beyond the user-configured value (which could exceed API limits).
        const originalBudget = this.thinkingBudgetTokens;
        let effectiveBudgetTokens: number | undefined;
        if (originalBudget && originalBudget >= 1024) {
          const roomForThinking = this.maxTokens - MIN_OUTPUT_TOKENS_WHEN_THINKING;
          if (roomForThinking >= 1024) {
            effectiveBudgetTokens = Math.min(originalBudget, roomForThinking);
          }
          // If maxTokens is too small to accommodate both thinking and output,
          // thinking is silently disabled — the user's maxTokens takes priority.
        }
        const thinkingEnabled = effectiveBudgetTokens !== undefined;
        const effectiveMaxTokens = this.maxTokens;

        response = await fetch(resolveAnthropicMessagesUrl(this.baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            ...(shouldUseContextManagement(this.thinkingBudgetTokens, this.thinkingKeepTurns)
              ? { 'anthropic-beta': CONTEXT_MANAGEMENT_BETA }
              : {}),
            ...resolveCustomHeaders(this.customHeaders),
          },
          body: JSON.stringify({
            model: this._modelName,
            max_tokens: effectiveMaxTokens,
            ...(noStream ? {} : { stream: true }),
            ...(thinkingEnabled
              ? { thinking: { type: 'enabled', budget_tokens: effectiveBudgetTokens } }
              : {}),
            ...(shouldUseContextManagement(this.thinkingBudgetTokens, this.thinkingKeepTurns)
              ? { context_management: createContextManagementConfig(this.thinkingKeepTurns) }
              : {}),
            ...(compiled.system ? { system: compiled.system } : {}),
            messages: compiled.messages,
            ...(compiled.tools && compiled.tools.length > 0 ? { tools: compiled.tools } : {}),
          }),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          const err = new Error(`Anthropic API error ${response.status}: ${errorText}`);
          (err as any).status = response.status;
          throw err;
        }

        if (noStream) {
          const payload = await response.json() as AnthropicCompatErrorPayload;
          if (isCompatErrorPayload(payload)) {
            const err = new Error(`Anthropic-compatible API error ${payload.code ?? 'unknown'}: ${payload.msg ?? payload.message ?? 'unknown error'}`);
            (err as any).status = payload.code;
            throw err;
          }
          return parseAnthropicJsonResponse(payload);
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const payload = await response.json() as AnthropicCompatErrorPayload;
          if (isCompatErrorPayload(payload)) {
            const err = new Error(`Anthropic-compatible API error ${payload.code ?? 'unknown'}: ${payload.msg ?? payload.message ?? 'unknown error'}`);
            (err as any).status = payload.code;
            throw err;
          }
          throw new Error(`Anthropic streaming expected SSE but received JSON: ${JSON.stringify(payload)}`);
        }

        if (!response.body) {
          throw new Error('Anthropic API returned an empty response body');
        }

        return await readAnthropicStream(response.body, options?.signal);
      } catch (error) {
        // 中断错误不重试，直接传播
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }

        const status = (error as any)?.status as number | undefined;
        if (attempt <= DEFAULT_MAX_RETRIES && shouldRetry(error, status)) {
          const retryAfterMs = parseRetryAfter(response?.headers);
          const delayMs = getRetryDelay(attempt, retryAfterMs);
          await sleep(delayMs);
          continue;
        }
        // 重试耗尽或不可重试 → 分类包装后抛出
        throw classifyAndWrapError(error, status);
      }
    }

    // 理论上不会到这里，但 TypeScript 需要返回值
    throw new Error('Anthropic API call failed after all retries');
  }
}

function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+$/i.test(normalized)) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

function isCompatErrorPayload(payload: AnthropicCompatErrorPayload): boolean {
  if (payload.success === false) return true;
  if (typeof payload.code === 'number' && payload.code !== 0) return true;
  return false;
}

function shouldUseContextManagement(thinkingBudgetTokens?: number, thinkingKeepTurns?: number): boolean {
  return !!thinkingBudgetTokens && thinkingBudgetTokens >= 1024 && (thinkingKeepTurns ?? DEFAULT_THINKING_KEEP_TURNS) > 0;
}

function createContextManagementConfig(keepTurns: number): AnthropicContextManagementConfig {
  return {
    edits: [
      {
        type: 'clear_thinking_20251015',
        keep: {
          type: 'thinking_turns',
          value: keepTurns,
        },
      },
    ],
  };
}

export function compileContextForAnthropic(messages: Message[], tools: Tool[], visionEnabled: boolean = false): CompiledAnthropicRequest {
  const systemBlocks: AnthropicTextBlock[] = [];
  const compiledMessages: AnthropicRequestMessage[] = [];
  let seenFirstUser = false;
  let pendingUserBlocks: AnthropicContentBlock[] = [];

  const flushPendingUserBlocks = (): void => {
    if (pendingUserBlocks.length === 0) return;
    compiledMessages.push({ role: 'user', content: pendingUserBlocks });
    pendingUserBlocks = [];
  };

  for (const message of messages) {
    if (!seenFirstUser && message.role === 'system') {
      systemBlocks.push({
        type: 'text',
        text: message.content,
        cache_control: { type: 'ephemeral' },
      });
      continue;
    }

    if (!seenFirstUser && message.role !== 'user') {
      throw new Error(`Anthropic compilation requires the first non-system message to be user, got '${message.role}'`);
    }

    switch (message.role) {
      case 'system':
        pendingUserBlocks.push({
          type: 'text',
          text: wrapReminder(message.content),
        });
        break;
      case 'tool':
        pendingUserBlocks.push(toolMessageToAnthropicBlock(message));
        break;
      case 'user': {
        seenFirstUser = true;
        const contentBlocks: AnthropicContentBlock[] = [...pendingUserBlocks];
        let textContent = message.content;

        // 处理图片
        if (message.images && message.images.length > 0) {
          if (visionEnabled) {
            for (const img of message.images) {
              const data = resolveImageBase64(img);
              if (data) {
                contentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: img.mediaType || 'image/png',
                    data,
                  },
                });
              }
            }
          } else {
            // 非视觉模式：降级为文字占位符
            const placeholders = message.images
              .map(img => `【Image】${img.source || '(inline image)'}`)
              .join('\n');
            textContent = `${message.content}\n${placeholders}`;
          }
        }

        contentBlocks.push({ type: 'text', text: textContent });
        compiledMessages.push({
          role: 'user',
          content: contentBlocks.length === 1 ? textContent : contentBlocks,
        });
        pendingUserBlocks = [];
        break;
      }
      case 'assistant':
        flushPendingUserBlocks();
        compiledMessages.push({
          role: 'assistant',
          content: assistantMessageToAnthropicContent(message),
        });
        break;
      default:
        throw new Error(`Anthropic compilation does not support message role '${message.role}'`);
    }
  }

  flushPendingUserBlocks();

  return {
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages: compiledMessages,
    ...(tools.length > 0 ? { tools: tools.map(toolToAnthropicDefinition) } : {}),
  };
}

function wrapReminder(text: string): string {
  const trimmed = text.trim();
  return /^<reminder[\s>]/.test(trimmed) ? trimmed : `<reminder>${trimmed}</reminder>`;
}

function toolToAnthropicDefinition(tool: Tool): AnthropicToolDef {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: 'object', properties: {} },
  };
}

function assistantMessageToAnthropicContent(message: Message): string | AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  if (message.thinkingBlocks) {
    for (const thinkingBlock of message.thinkingBlocks) {
      blocks.push({
        type: 'thinking',
        thinking: thinkingBlock.thinking,
        signature: thinkingBlock.signature,
      });
    }
  }

  if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }

  if (message.toolCalls) {
    for (const toolCall of message.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments,
      });
    }
  }

  if (blocks.length === 0) {
    return '';
  }

  if (blocks.length === 1 && blocks[0].type === 'text') {
    return blocks[0].text;
  }

  return blocks;
}

function toolMessageToAnthropicBlock(message: Message): AnthropicToolResultBlock {
  if (!message.toolCallId) {
    throw new Error('Anthropic compilation requires tool messages to include toolCallId');
  }

  const parsed = parseToolPayload(message.content);
  return {
    type: 'tool_result',
    tool_use_id: message.toolCallId,
    content: parsed.content,
    ...(parsed.isError ? { is_error: true } : {}),
  };
}

function parseToolPayload(content: string): { content: string; isError: boolean } {
  try {
    const parsed = JSON.parse(content) as { success?: boolean; result?: unknown; error?: unknown };
    if (parsed && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed || 'success' in parsed)) {
      const isError = parsed.success === false || !!parsed.error;
      if (isError && typeof parsed.error === 'string' && parsed.error.trim()) {
        return { content: parsed.error, isError: true };
      }
      if (parsed.result !== undefined) {
        return { content: stringifyToolValue(parsed.result), isError };
      }
      return { content, isError };
    }
  } catch {
    // Keep raw tool content if it is not JSON.
  }

  return { content, isError: false };
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Find the index right after the first SSE event boundary in a text buffer.
 * Matches the Anthropic SDK's findDoubleNewlineIndex behavior — supports
 * \n\n, \r\r, and \r\n\r\n separators. Returns -1 if none found.
 */
function findDoubleNewlineIndex(buffer: string): { index: number; separatorLen: number } {
  for (let i = 0; i < buffer.length - 1; i++) {
    const ch = buffer[i];
    const next = buffer[i + 1];
    if (ch === '\n' && next === '\n') return { index: i, separatorLen: 2 };
    if (ch === '\r' && next === '\r') return { index: i, separatorLen: 2 };
    if (ch === '\r' && next === '\n' && i + 3 < buffer.length && buffer[i + 2] === '\r' && buffer[i + 3] === '\n') {
      return { index: i, separatorLen: 4 };
    }
  }
  return { index: -1, separatorLen: 0 };
}

/**
 * Parse a non-streaming Anthropic API JSON response into LLMResponse.
 * Used when noStream option is set — avoids SSE fragility for one-shot calls.
 */
function parseAnthropicJsonResponse(data: Record<string, any>): LLMResponse {
  let content = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];

  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        content += block.text;
      } else if (block.type === 'thinking') {
        const thinking = typeof block.thinking === 'string' ? block.thinking : '';
        const signature = typeof block.signature === 'string' ? block.signature : '';
        if (thinking) reasoning += thinking;
        if (signature.length > 0 && thinking.length > 0) {
          thinkingBlocks.push({ thinking, signature });
        }
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id ?? ''),
          name: String(block.name ?? ''),
          arguments: (block.input && typeof block.input === 'object' && !Array.isArray(block.input))
            ? block.input as Record<string, any>
            : {},
        });
      }
    }
  }

  const usageRaw = data.usage;
  let usageInfo: UsageInfo | undefined;
  if (usageRaw && (usageRaw.input_tokens !== undefined || usageRaw.output_tokens !== undefined)) {
    const realInput = (usageRaw.input_tokens || 0)
      + (usageRaw.cache_creation_input_tokens || 0)
      + (usageRaw.cache_read_input_tokens || 0);
    usageInfo = {
      inputTokens: realInput,
      outputTokens: usageRaw.output_tokens || 0,
      totalTokens: realInput + (usageRaw.output_tokens || 0),
      ...(usageRaw.cache_creation_input_tokens ? { cacheCreationTokens: usageRaw.cache_creation_input_tokens } : {}),
      ...(usageRaw.cache_read_input_tokens ? { cacheReadTokens: usageRaw.cache_read_input_tokens } : {}),
    };
  }

  return {
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    ...(usageInfo ? { usage: usageInfo } : {}),
    stopReason: data.stop_reason ?? null,
  };
}

async function readAnthropicStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<LLMResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const pendingThinkingBlocks = new Map<number, PendingThinkingBlock>();
  let charCount = 0;
  let currentPhase: LLMPhase = 'content';
  const pendingToolUses = new Map<number, PendingToolUse>();

  // 收集 usage 数据
  let usageInfo: UsageInfo | null = null;

  // 收集 stop_reason
  let stopReason: string | null = null;

  // 流式完整性追踪
  let receivedMessageStart = false;
  let receivedMessageStop = false;

  // 创建 signal abort 监听 Promise，用于 race 中断 reader.read()
  const createAbortPromise = (): Promise<never> => new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      signal!.removeEventListener('abort', onAbort);
      reader.cancel().catch(() => {});
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  const applyEvent = (event: AnthropicStreamEvent): void => {
    if (event.type === 'message_start') receivedMessageStart = true;
    if (event.type === 'message_stop') receivedMessageStop = true;
    applyAnthropicStreamEvent(event, pendingThinkingBlocks, pendingToolUses, (delta) => {
      content += delta.content;
      reasoning += delta.reasoning;
      charCount += delta.charCount;
      currentPhase = delta.phase;
    }, (usage) => {
      usageInfo = usage;
    }, (reason) => {
      stopReason = reason;
    });
  };

  try {
    while (true) {
      // 用 Promise.race 让 reader.read() 可被 signal 中断
      const { value, done } = signal
        ? await Promise.race([reader.read(), createAbortPromise()])
        : await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let sep = findDoubleNewlineIndex(buffer);
      while (sep.index >= 0) {
        const rawEvent = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.separatorLen);
        const event = parseSSEEvent(rawEvent);
        if (event) {
          applyEvent(event);
          await emitAnthropicProgress(charCount, currentPhase, pendingToolUses.size);
        }
        sep = findDoubleNewlineIndex(buffer);
      }
    }
  } catch (e) {
    // AbortError 直接传播
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw e;
  }

  // 处理缓冲区中最后的残余数据
  if (buffer.trim()) {
    const event = parseSSEEvent(buffer);
    if (event) {
      applyEvent(event);
      await emitAnthropicProgress(charCount, currentPhase, pendingToolUses.size);
    }
  }

  // 检测不完整流：收到了 message_start 但没有 message_stop，也没有任何有效内容
  if (receivedMessageStart && !receivedMessageStop && !content && pendingToolUses.size === 0 && !reasoning) {
    throw new Error('Anthropic stream ended incompletely: received message_start but no message_stop or content');
  }

  const toolCalls = finalizeToolCalls(pendingToolUses);
  const thinkingBlocks = finalizeThinkingBlocks(pendingThinkingBlocks);
  await emitAnthropicComplete(charCount);
  return {
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    ...(usageInfo ? { usage: usageInfo } : {}),
    stopReason,
  };
}

function parseSSEEvent(rawEvent: string): AnthropicStreamEvent | null {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim());

  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return null;

  try {
    return JSON.parse(data) as AnthropicStreamEvent;
  } catch {
    // Skip malformed SSE events instead of crashing the entire stream.
    console.warn(`[Anthropic] Skipping malformed SSE event: ${data.slice(0, 200)}`);
    return null;
  }
}

function applyAnthropicStreamEvent(
  event: AnthropicStreamEvent,
  pendingThinkingBlocks: Map<number, PendingThinkingBlock>,
  pendingToolUses: Map<number, PendingToolUse>,
  append: (delta: { content: string; reasoning: string; charCount: number; phase: LLMPhase }) => void,
  onUsage: (usage: UsageInfo) => void,
  onStopReason?: (stopReason: string) => void,
): void {
  switch (event.type) {
    case 'content_block_start': {
      if (event.content_block?.type === 'thinking' && typeof event.index === 'number') {
        pendingThinkingBlocks.set(event.index, {
          thinking: event.content_block.thinking || '',
          signature: event.content_block.signature || '',
        });
      }
      if (event.content_block?.type === 'tool_use' && typeof event.index === 'number') {
        pendingToolUses.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          // Always start with empty string — the API sends input: {} at
          // content_block_start but actual content arrives via
          // input_json_delta events.  Initializing with a stringified
          // non-empty object would corrupt the accumulated JSON when
          // deltas are appended.  (Matches Claude Code's approach.)
          inputJson: '',
        });
      }
      break;
    }
    case 'content_block_delta': {
      const deltaType = event.delta?.type;
      if (deltaType === 'text_delta') {
        const text = event.delta?.text ?? '';
        append({ content: text, reasoning: '', charCount: text.length, phase: 'content' });
      } else if (deltaType === 'thinking_delta') {
        const thinking = event.delta?.thinking ?? '';
        if (typeof event.index === 'number') {
          const block = pendingThinkingBlocks.get(event.index) ?? { thinking: '', signature: '' };
          block.thinking += thinking;
          pendingThinkingBlocks.set(event.index, block);
        }
        append({ content: '', reasoning: thinking, charCount: thinking.length, phase: 'thinking' });
      } else if (deltaType === 'signature_delta' && typeof event.index === 'number') {
        const block = pendingThinkingBlocks.get(event.index) ?? { thinking: '', signature: '' };
        block.signature += ((event.delta as { signature?: string }).signature ?? '');
        pendingThinkingBlocks.set(event.index, block);
      } else if (deltaType === 'input_json_delta' && typeof event.index === 'number') {
        const toolUse = pendingToolUses.get(event.index);
        if (toolUse) {
          const partial = event.delta?.partial_json ?? '';
          toolUse.inputJson = mergeToolInputJson(toolUse.inputJson, partial);
          append({ content: '', reasoning: '', charCount: 0, phase: 'tool_calling' });
        } else {
          console.warn(`[Anthropic] input_json_delta for unknown content block index ${event.index}, skipping`);
        }
      }
      break;
    }
    case 'message_start': {
      const usage = event.message?.usage;
      if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
        const realInput = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        onUsage({
          inputTokens: realInput,
          outputTokens: usage.output_tokens || 0,
          totalTokens: realInput + (usage.output_tokens || 0),
          ...(usage.cache_creation_input_tokens ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
          ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
        });
      }
      break;
    }
    case 'message_delta': {
      // Anthropic 的 message_delta usage 在事件顶层，不在 delta 里
      if (event.delta?.stop_reason && onStopReason) {
        onStopReason(event.delta.stop_reason);
      }
      const usage = event.usage;
      if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
        const realInput = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        onUsage({
          inputTokens: realInput,
          outputTokens: usage.output_tokens || 0,
          totalTokens: realInput + (usage.output_tokens || 0),
          ...(usage.cache_creation_input_tokens ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
          ...(usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
        });
      }
      break;
    }
    default:
      break;
  }
}

async function emitAnthropicProgress(charCount: number, phase: LLMPhase, toolCallCount: number): Promise<void> {
  try {
    const { emitNotification, createLLMCharCount } = await import('../core/notification.js');
    if (charCount > 0 || toolCallCount > 0) {
      emitNotification(createLLMCharCount(charCount, phase));
    }
  } catch {
    // Ignore notification failures.
  }
}

async function emitAnthropicComplete(charCount: number): Promise<void> {
  try {
    const { emitNotification, createLLMComplete } = await import('../core/notification.js');
    emitNotification(createLLMComplete(charCount));
  } catch {
    // Ignore notification failures.
  }
}

function mergeToolInputJson(current: string, partial: string): string {
  if (!current.trim()) return partial;
  return current + partial;
}

function finalizeThinkingBlocks(pendingThinkingBlocks: Map<number, PendingThinkingBlock>): ThinkingBlock[] {
  return Array.from(pendingThinkingBlocks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => ({
      signature: block.signature,
      thinking: block.thinking,
    }))
    .filter(block => block.signature.length > 0 && block.thinking.length > 0);
}

function finalizeToolCalls(pendingToolUses: Map<number, PendingToolUse>): ToolCall[] {
  return Array.from(pendingToolUses.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, toolUse]) => ({
      id: toolUse.id,
      name: toolUse.name,
      arguments: parseToolInput(toolUse.inputJson, toolUse.name),
    }));
}

function stripBOM(str: string): string {
  // eslint-disable-next-line no-irregular-whitespace -- BOM 字符 (U+FEFF) 是正则匹配目标
  return str.replace(/^﻿/, '');
}

function safeParseJSON(json: string): unknown {
  if (!json) return null;
  try {
    return JSON.parse(stripBOM(json));
  } catch {
    return null;
  }
}

function parseToolInput(inputJson: string, toolName?: string): Record<string, any> {
  const trimmed = inputJson.trim();
  if (!trimmed) return {};

  const parsed = safeParseJSON(trimmed);
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, any>;
  }

  // Fallback: some Anthropic-compatible endpoints produce tool-call input JSON
  // with trailing non-JSON content in streaming deltas. Try extracting the
  // first valid JSON object from the string.
  const braceStart = trimmed.indexOf('{');
  if (braceStart >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = braceStart; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { if (inString) escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(braceStart, i + 1);
          const recovered = safeParseJSON(candidate);
          if (recovered !== null && typeof recovered === 'object' && !Array.isArray(recovered)) {
            return recovered as Record<string, any>;
          }
          break;
        }
      }
    }
  }

  // Graceful degradation: never throw — return empty object and let the
  // downstream tool execution deal with missing arguments. This mirrors
  // Claude Code's approach where a parse failure falls back to `{}` so the
  // ReAct loop keeps running instead of crashing entirely.
  console.warn(
    `[Anthropic] Failed to parse tool input JSON${toolName ? ` for tool "${toolName}"` : ''}. ` +
    `Input length: ${trimmed.length}, preview: ${trimmed.slice(0, 200)}`,
  );
  return {};
}

export function createAnthropicLLM(config: AgentConfigFile): AnthropicLLM;
export function createAnthropicLLM(modelConfig: ModelConfig): AnthropicLLM;
export function createAnthropicLLM(
  apiKey: string,
  modelName: string,
  baseUrl?: string,
): AnthropicLLM;
export function createAnthropicLLM(
  configOrApiKey: AgentConfigFile | ModelConfig | string,
  modelName?: string,
  baseUrl?: string,
): AnthropicLLM {
  if (typeof configOrApiKey === 'object' && 'defaultModel' in configOrApiKey) {
    return new AnthropicLLM(
      configOrApiKey.defaultModel.apiKey,
      configOrApiKey.defaultModel.model,
      configOrApiKey.defaultModel.baseUrl,
      (configOrApiKey.defaultModel.maxTokens && configOrApiKey.defaultModel.maxTokens > 0) ? configOrApiKey.defaultModel.maxTokens : DEFAULT_MAX_TOKENS,
      configOrApiKey.defaultModel.thinkingBudgetTokens,
      configOrApiKey.defaultModel.thinkingKeepTurns ?? DEFAULT_THINKING_KEEP_TURNS,
      configOrApiKey.defaultModel.customHeaders,
      configOrApiKey.defaultModel.vision ?? false,
    );
  }

  if (typeof configOrApiKey === 'object') {
    return new AnthropicLLM(
      configOrApiKey.apiKey,
      configOrApiKey.model,
      configOrApiKey.baseUrl,
      (configOrApiKey.maxTokens && configOrApiKey.maxTokens > 0) ? configOrApiKey.maxTokens : DEFAULT_MAX_TOKENS,
      configOrApiKey.thinkingBudgetTokens,
      configOrApiKey.thinkingKeepTurns ?? DEFAULT_THINKING_KEEP_TURNS,
      configOrApiKey.customHeaders,
      configOrApiKey.vision ?? false,
    );
  }

  return new AnthropicLLM(configOrApiKey, modelName!, baseUrl);
}
