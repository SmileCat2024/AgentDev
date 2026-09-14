/**
 * 流式空闲超时（idle deadline）集成测试
 *
 * 语义契约：
 * - 流式调用只要数据持续到达，总时长超过 timeoutMs 也必须正常完成
 *   （回归原 bug：固定墙钟定时器打断长思考流式输出）。
 * - 流静默超过 timeoutMs 才判定断连：以超时错误拒绝，且不进入重试。
 *
 * 三个客户端（openai / openai-responses / anthropic）都按此契约验证。
 * stub 均遵循真实传输层行为：signal abort 时，挂起的等待以 signal.reason 拒绝。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAnthropicLLM,
  createOpenAILLM,
  createOpenAIResponsesLLM,
} from '../../src/index.js';

// 受 signal 约束的延时：abort 时以 signal.reason 拒绝，模拟 undici fetch 的行为
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const rejectWithReason = () =>
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) {
      rejectWithReason();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rejectWithReason();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// 跳过 ensureHttpClientInitialized，避免单测触碰全局 undici dispatcher
function disableHttpInit(llm: unknown): void {
  (llm as any).initPromise = Promise.resolve();
}

async function captureError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

function expectIdleTimeoutRejection(error: any, timeoutMs: number): void {
  expect(error.name).toBe('ClassifiedAPIError');
  expect(error.originalError?.name).toBe('TimeoutError');
  expect(error.originalError?.message).toContain(`no data received for ${timeoutMs}ms`);
}

// —— OpenAI chat.completions ——

function openAIChunk(content?: string, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  };
}

function stubOpenAIClient(llm: unknown, script: Array<{ delayMs: number; chunk?: unknown }>) {
  const create = vi.fn(async (_body: unknown, opts: { signal?: AbortSignal }) => {
    const signal = opts.signal;
    return (async function* () {
      for (const step of script) {
        await abortableDelay(step.delayMs, signal);
        if (step.chunk) yield step.chunk;
      }
    })();
  });
  (llm as any).client = { chat: { completions: { create } } };
  return create;
}

describe('OpenAILLM idle deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes a stream whose total duration exceeds the deadline while chunks keep arriving', async () => {
    const TIMEOUT_MS = 1000;
    const llm = createOpenAILLM({ apiKey: 'k', model: 'm', timeoutMs: TIMEOUT_MS, maxRetries: 2 });
    disableHttpInit(llm);

    const segments = Array.from({ length: 20 }, (_, i) => `段${i}`);
    const script = [
      ...segments.map((text) => ({ delayMs: 100, chunk: openAIChunk(text) })),
      { delayMs: 100, chunk: openAIChunk(undefined, 'stop') },
    ]; // 总时长 2100ms > deadline 1000ms
    const create = stubOpenAIClient(llm, script);

    const pending = llm.chat([{ role: 'user', content: 'hi' }], []);
    await vi.advanceTimersByTimeAsync(2100);
    const result = await pending;

    expect(result.content).toBe(segments.join(''));
    expect(result.stopReason).toBe('stop');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects with a timeout error without retrying when the stream goes silent past the deadline', async () => {
    const TIMEOUT_MS = 500;
    const llm = createOpenAILLM({ apiKey: 'k', model: 'm', timeoutMs: TIMEOUT_MS, maxRetries: 3 });
    disableHttpInit(llm);

    const create = stubOpenAIClient(llm, [
      { delayMs: 50, chunk: openAIChunk('开头') },
      { delayMs: 60_000, chunk: openAIChunk('迟到的数据') }, // 50ms 后静默，远超 deadline
    ]);

    const settled = captureError(llm.chat([{ role: 'user', content: 'hi' }], []));
    await vi.advanceTimersByTimeAsync(2000);
    const error = await settled;

    expectIdleTimeoutRejection(error, TIMEOUT_MS);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// —— OpenAI Responses ——

function stubResponsesClient(llm: unknown, script: Array<{ delayMs: number; event?: unknown }>) {
  const stream = vi.fn((_params: unknown, opts: { signal?: AbortSignal }) => {
    const signal = opts.signal;
    return (async function* () {
      for (const step of script) {
        await abortableDelay(step.delayMs, signal);
        if (step.event) yield step.event;
      }
    })();
  });
  (llm as any).client = { responses: { stream } };
  return stream;
}

describe('OpenAIResponsesLLM idle deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes a long stream while events keep arriving', async () => {
    const TIMEOUT_MS = 1000;
    const llm = createOpenAIResponsesLLM({ apiKey: 'k', model: 'm', timeoutMs: TIMEOUT_MS, maxRetries: 2 });
    disableHttpInit(llm);

    const segments = Array.from({ length: 20 }, (_, i) => `回复${i}`);
    const script = [
      ...segments.map((delta) => ({ delayMs: 100, event: { type: 'response.output_text.delta', delta } })),
      { delayMs: 100, event: { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } } },
    ];
    const stream = stubResponsesClient(llm, script);

    const pending = llm.chat([{ role: 'user', content: 'hi' }], []);
    await vi.advanceTimersByTimeAsync(2100);
    const result = await pending;

    expect(result.content).toBe(segments.join(''));
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('rejects with a timeout error without retrying when the stream goes silent past the deadline', async () => {
    const TIMEOUT_MS = 500;
    const llm = createOpenAIResponsesLLM({ apiKey: 'k', model: 'm', timeoutMs: TIMEOUT_MS, maxRetries: 3 });
    disableHttpInit(llm);

    const stream = stubResponsesClient(llm, [
      { delayMs: 50, event: { type: 'response.output_text.delta', delta: '开头' } },
      { delayMs: 60_000, event: { type: 'response.completed', response: { status: 'completed', output: [] } } },
    ]);

    const settled = captureError(llm.chat([{ role: 'user', content: 'hi' }], []));
    await vi.advanceTimersByTimeAsync(2000);
    const error = await settled;

    expectIdleTimeoutRejection(error, TIMEOUT_MS);
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

// —— Anthropic（原生 fetch + SSE） ——

function sseFrame(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function anthropicSuccessScript(segments: string[]): Array<{ delayMs: number; event: Record<string, unknown> }> {
  return [
    { delayMs: 20, event: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } } },
    { delayMs: 20, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    ...segments.map((text) => ({
      delayMs: 100,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    })),
    { delayMs: 20, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
    { delayMs: 20, event: { type: 'message_stop' } },
  ];
}

function stubAnthropicFetch(script: Array<{ delayMs: number; event?: Record<string, unknown> }>) {
  const encoder = new TextEncoder();
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // 模拟真实 fetch：abort 监听在请求建立时注册（必然早于消费者的
        // reader.cancel 监听），abort 时 body 流以 signal.reason 报错，
        // 挂起的 read() 随之拒绝
        const fail = (error: unknown) => {
          try {
            controller.error(error);
          } catch {
            // 流已被关闭/报错
          }
        };
        signal?.addEventListener('abort', () => fail(signal.reason), { once: true });
        (async () => {
          for (const step of script) {
            try {
              await abortableDelay(step.delayMs, signal);
            } catch (error) {
              fail(error);
              return;
            }
            if (step.event) {
              try {
                controller.enqueue(encoder.encode(sseFrame(step.event)));
              } catch {
                return;
              }
            }
          }
          try {
            controller.close();
          } catch {
            // 已 abort
          }
        })();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function createAnthropicUnderTest(timeoutMs: number, maxRetries: number) {
  const llm = createAnthropicLLM({
    defaultModel: { apiKey: 'k', model: 'm', timeoutMs, maxRetries },
  });
  disableHttpInit(llm);
  return llm;
}

describe('AnthropicLLM idle deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('completes a long stream while SSE events keep arriving', async () => {
    const TIMEOUT_MS = 1000;
    const llm = createAnthropicUnderTest(TIMEOUT_MS, 2);

    const segments = Array.from({ length: 20 }, (_, i) => `内容${i}`);
    // 总时长约 2080ms > deadline 1000ms
    const fetchMock = stubAnthropicFetch(anthropicSuccessScript(segments));

    const pending = llm.chat([{ role: 'user', content: 'hi' }], []);
    await vi.advanceTimersByTimeAsync(2200);
    const result = await pending;

    expect(result.content).toBe(segments.join(''));
    expect(result.stopReason).toBe('end_turn');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with a timeout error without retrying when the stream goes silent past the deadline', async () => {
    const TIMEOUT_MS = 500;
    const llm = createAnthropicUnderTest(TIMEOUT_MS, 3);

    const fetchMock = stubAnthropicFetch([
      { delayMs: 50, event: { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } } },
      { delayMs: 50, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '开头' } } },
      { delayMs: 60_000, event: { type: 'message_stop' } }, // 100ms 后静默，远超 deadline
    ]);

    const settled = captureError(llm.chat([{ role: 'user', content: 'hi' }], []));
    await vi.advanceTimersByTimeAsync(2000);
    const error = await settled;

    expectIdleTimeoutRejection(error, TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
