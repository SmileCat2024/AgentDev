/**
 * LLM API 重试机制
 *
 * 对标 Claude Code withRetry 的同款实现：
 * - HTTP 状态码驱动的重试决策
 * - 指数退避 + 25% 随机抖动
 * - Retry-After 响应头优先
 * - 网络错误码匹配（Undici/Node.js）
 */

/**
 * 默认最大重试次数（与 Claude Code 一致）
 */
export const DEFAULT_MAX_RETRIES = 10;

/**
 * 模型调用默认最大重试次数（ModelConfig.maxRetries 缺省时由 LLM 工厂填充）
 */
export const DEFAULT_MODEL_MAX_RETRIES = 10;

/**
 * 模型调用默认整体时限：10 分钟（ModelConfig.timeoutMs 缺省时由 LLM 工厂填充）。
 * 与 OpenAI SDK 默认单请求 timeout 对齐；流式传输全程受此 deadline 约束。
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 600_000;

/**
 * 基础退避延迟 500ms（与 Claude Code 一致）
 */
const BASE_DELAY_MS = 500;

/**
 * 最大退避延迟 32s（与 Claude Code 一致）
 */
const MAX_DELAY_MS = 32000;

/**
 * 可重试的 HTTP 状态码集合
 */
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  408, // Request Timeout
  409, // Conflict / Lock timeout
  429, // Rate Limit
  529, // Overloaded (Anthropic 特有，但对其他 API 也可重试)
]);

/**
 * 可重试的网络底层错误码（Undici / Node.js fetch）
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  // Undici 错误
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  // 系统级网络错误
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  // 协议层错误
  'EPROTO',
  'EPIPE',
]);

type HeaderMap = Record<string, string | number | string[] | undefined>;
type HeadersLike = Headers | HeaderMap | undefined;

/**
 * 从 Response Headers 解析 Retry-After（秒），返回毫秒
 *
 * OpenAI SDK 的错误对象会把 headers 暴露成普通对象，而 fetch response
 * 暴露的是 Headers 实例。这里同时兼容两种形态，避免错误处理本身盖住真实 API 错误。
 */
export function parseRetryAfter(headers: HeadersLike): number | undefined {
  const retryAfter = getHeaderValue(headers, 'retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return undefined;
}

function getHeaderValue(headers: HeadersLike, name: string): string | undefined {
  if (!headers) return undefined;

  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) || undefined;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as HeaderMap)) {
    if (key.toLowerCase() !== lowerName || value === undefined) continue;
    if (Array.isArray(value)) {
      return value.join(', ');
    }
    return String(value);
  }

  return undefined;
}

/**
 * 指数退避 + 随机抖动
 *
 * 公式: min(500ms * 2^(attempt-1), 32000ms) + [0, 25%) 随机抖动
 * 如果传入了 retryAfterMs 则优先使用服务端指令
 */
export function getRetryDelay(attempt: number, retryAfterMs?: number): number {
  // 优先遵循服务端 Retry-After 指令
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs;
  }

  // 指数退避: 500ms * 2^(attempt-1)，上限 32s
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
  // 25% 随机抖动
  const jitter = Math.random() * 0.25 * baseDelay;
  return baseDelay + jitter;
}

/**
 * 判断错误是否可重试
 *
 * 检查顺序:
 * 1. HTTP 5xx 服务端错误
 * 2. 特定可重试状态码 (408/409/429/529)
 * 3. overloaded_error（529 在流式请求中可能丢状态码）
 * 4. 网络底层错误码
 */
export function shouldRetry(
  error: unknown,
  status?: number,
): boolean {
  // 1. 服务端错误 5xx 始终重试
  if (status !== undefined && status >= 500) {
    return true;
  }

  // 2. 特定可重试状态码
  if (status !== undefined && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  // 3. overloaded_error（SDK 在流式请求中可能丢 529 状态码，
  //    但错误消息中会包含 "type":"overloaded_error"）
  if (error instanceof Error && error.message.includes('"type":"overloaded_error"')) {
    return true;
  }

  // 4. 网络底层错误码（遍历 cause 链）
  const code = extractErrorCode(error);
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  return false;
}

/**
 * 从错误对象中提取错误码（遍历 cause 链找到第一个有 code 的属性）
 */
export function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;

  let current: unknown = error;
  const maxDepth = 5;
  let depth = 0;

  while (current && depth < maxDepth) {
    if (current instanceof Error && 'code' in current && typeof (current as any).code === 'string') {
      return (current as any).code as string;
    }
    if (current instanceof Error && 'cause' in current && (current as any).cause !== current) {
      current = (current as any).cause;
      depth++;
    } else {
      break;
    }
  }

  return undefined;
}

/**
 * retry sleep — 可中断的 sleep
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 合并外部中断信号与整体时限为单一 AbortSignal。
 *
 * - 任一先触发即生效；deadline 到达时以 TimeoutError DOMException 中止，
 *   上游按 AbortError 处理（不重试、直接传播）。
 * - timeoutMs 为 undefined / Infinity 时仅透传外部信号（不额外建 controller）。
 */
export function withDeadline(signal: AbortSignal | undefined, timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs === Infinity || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return signal;
  }
  const merged = new AbortController();
  if (signal) {
    if (signal.aborted) {
      merged.abort(signal.reason);
      return merged.signal;
    }
    const onExternalAbort = () => merged.abort(signal.reason);
    signal.addEventListener('abort', onExternalAbort, { once: true });
    // 外部 signal 通常是长期存活的 agent signal：deadline 到点后必须解除上面的
    // listener，否则每次模型调用都会在外部 signal 上累积一个监听
    // （MaxListenersExceededWarning / EventTarget 泄漏）。
    merged.signal.addEventListener('abort', () => signal.removeEventListener('abort', onExternalAbort), { once: true });
  }
  const timer = setTimeout(
    () => merged.abort(new DOMException(`Model call deadline exceeded after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs,
  );
  // deadline 触发后定时器自然释放；提前结束时由 GC 回收，无需显式清理
  void timer;
  return merged.signal;
}

/**
 * 从 ModelConfig 解析生效的重试上限与整体时限，缺省时填充框架默认值。
 */
export function resolveModelCallPolicy(config?: { maxRetries?: number; timeoutMs?: number }): {
  maxRetries: number;
  timeoutMs: number | undefined;
} {
  let maxRetries = DEFAULT_MODEL_MAX_RETRIES;
  if (typeof config?.maxRetries === 'number' && Number.isFinite(config.maxRetries) && config.maxRetries >= 0) {
    maxRetries = Math.floor(config.maxRetries);
  }
  let timeoutMs: number | undefined = DEFAULT_MODEL_TIMEOUT_MS;
  if (config?.timeoutMs !== undefined) {
    const v = config.timeoutMs;
    timeoutMs = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  }
  return { maxRetries, timeoutMs };
}
