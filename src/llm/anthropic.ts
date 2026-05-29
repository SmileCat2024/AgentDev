import type { AgentConfigFile, ModelConfig } from '../core/config.js';
import type { LLMClient, LLMResponse, Message, ThinkingBlock, Tool, ToolCall, UsageInfo } from '../core/types.js';
import type { LLMPhase } from '../core/types.js';
import { DEFAULT_MAX_RETRIES, getRetryDelay, parseRetryAfter, shouldRetry, sleep } from './retry.js';
import { classifyAndWrapError, ClassifiedAPIError } from './api-errors.js';
import { initHttpClient } from './http-client.js';

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

type AnthropicContentBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolResultBlock | AnthropicToolUseBlock;

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

export class AnthropicLLM implements LLMClient {
  private initPromise: Promise<void>;

  constructor(
    private readonly apiKey: string,
    private readonly modelName: string = 'claude-sonnet-4-5-20250929',
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly maxTokens: number = DEFAULT_MAX_TOKENS,
    private readonly thinkingBudgetTokens?: number,
    private readonly thinkingKeepTurns: number = DEFAULT_THINKING_KEEP_TURNS,
  ) {
    this.initPromise = ensureHttpClientInitialized();
  }

  async chat(messages: Message[], tools: Tool[], options?: { signal?: AbortSignal }): Promise<LLMResponse> {
    // 确保 HTTP 客户端已初始化
    await this.initPromise;
    const compiled = compileContextForAnthropic(messages, tools);

    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES + 1; attempt++) {
      let response: Response | undefined;
      try {
        // 检查中断信号
        if (options?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        response = await fetch(resolveAnthropicMessagesUrl(this.baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            ...(shouldUseContextManagement(this.thinkingBudgetTokens, this.thinkingKeepTurns)
              ? { 'anthropic-beta': CONTEXT_MANAGEMENT_BETA }
              : {}),
          },
          body: JSON.stringify({
            model: this.modelName,
            max_tokens: this.maxTokens,
            stream: true,
            ...(this.thinkingBudgetTokens && this.thinkingBudgetTokens >= 1024
              ? { thinking: { type: 'enabled', budget_tokens: this.thinkingBudgetTokens } }
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

export function compileContextForAnthropic(messages: Message[], tools: Tool[]): CompiledAnthropicRequest {
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
        const contentBlocks = [...pendingUserBlocks, { type: 'text' as const, text: message.content }];
        compiledMessages.push({
          role: 'user',
          content: contentBlocks.length === 1 ? message.content : contentBlocks,
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

  try {
    while (true) {
      // 用 Promise.race 让 reader.read() 可被 signal 中断
      const { value, done } = signal
        ? await Promise.race([reader.read(), createAbortPromise()])
        : await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const event = parseSSEEvent(rawEvent);
      if (event) {
        applyAnthropicStreamEvent(event, pendingThinkingBlocks, pendingToolUses, (delta) => {
          content += delta.content;
          reasoning += delta.reasoning;
          charCount += delta.charCount;
          currentPhase = delta.phase;
        }, (usage) => {
          // 收集 usage 数据
          usageInfo = usage;
        });
        await emitAnthropicProgress(charCount, currentPhase, pendingToolUses.size);
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
  } catch (e) {
    // AbortError 直接传播
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw e;
  }

  if (buffer.trim()) {
    const event = parseSSEEvent(buffer);
    if (event) {
      applyAnthropicStreamEvent(event, pendingThinkingBlocks, pendingToolUses, (delta) => {
        content += delta.content;
        reasoning += delta.reasoning;
        charCount += delta.charCount;
        currentPhase = delta.phase;
      }, (usage) => {
        // 收集 usage 数据
        usageInfo = usage;
      });
      await emitAnthropicProgress(charCount, currentPhase, pendingToolUses.size);
    }
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

  return JSON.parse(data) as AnthropicStreamEvent;
}

function applyAnthropicStreamEvent(
  event: AnthropicStreamEvent,
  pendingThinkingBlocks: Map<number, PendingThinkingBlock>,
  pendingToolUses: Map<number, PendingToolUse>,
  append: (delta: { content: string; reasoning: string; charCount: number; phase: LLMPhase }) => void,
  onUsage: (usage: UsageInfo) => void,
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
          inputJson: stringifyInitialInput(event.content_block.input),
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

function stringifyInitialInput(input: unknown): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0) {
    return '';
  }
  return JSON.stringify(input);
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
      arguments: parseToolInput(toolUse.inputJson),
    }));
}

function parseToolInput(inputJson: string): Record<string, any> {
  const trimmed = inputJson.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch {
    // Fallback: extract the first valid JSON object from the string.
    // Some Anthropic-compatible endpoints (e.g. DeepSeek) may produce
    // tool-call input JSON with trailing non-JSON content in streaming deltas.
    const braceStart = trimmed.indexOf('{');
    if (braceStart < 0) return {};
    let depth = 0;
    for (let i = braceStart; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(braceStart, i + 1);
          try {
            return JSON.parse(candidate) as Record<string, any>;
          } catch {
            break;
          }
        }
      }
    }
    throw new SyntaxError(`Failed to parse tool input JSON: ${trimmed.slice(0, 200)}`);
  }
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
      configOrApiKey.defaultModel.maxTokens ?? DEFAULT_MAX_TOKENS,
      configOrApiKey.defaultModel.thinkingBudgetTokens,
      configOrApiKey.defaultModel.thinkingKeepTurns ?? DEFAULT_THINKING_KEEP_TURNS,
    );
  }

  if (typeof configOrApiKey === 'object') {
    return new AnthropicLLM(
      configOrApiKey.apiKey,
      configOrApiKey.model,
      configOrApiKey.baseUrl,
      configOrApiKey.maxTokens ?? DEFAULT_MAX_TOKENS,
      configOrApiKey.thinkingBudgetTokens,
      configOrApiKey.thinkingKeepTurns ?? DEFAULT_THINKING_KEEP_TURNS,
    );
  }

  return new AnthropicLLM(configOrApiKey, modelName!, baseUrl);
}
