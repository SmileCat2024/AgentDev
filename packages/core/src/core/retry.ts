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
export const DEFAULT_MODEL_MAX_RETRIES = 5;

/**
 * 模型调用默认空闲时限：60 秒（ModelConfig.timeoutMs 缺省时由 LLM 工厂填充）。
 * 空闲语义：仅当持续该时长收不到任何远端活动（响应头、流式数据）才判定连接
 * 断开；流式输出持续到达的调用（如思考期间持续流出 reasoning delta）不受总
 * 时长限制。空闲超时以 TimeoutError 中止，按中断处理不重试。
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

/**
 * 模型调用首段默认预算：120 秒（请求发出 → 第一个流式数据 / 非流式响应体）。
 * 大上下文 + 高思考档位下首 token 静默经常超过 60s，首段独立放宽；响应头不算
 * 首 token（部分端点秒回 headers 后静默思考）。后续 chunk 间隔仍由
 * DEFAULT_MODEL_TIMEOUT_MS 约束。显式配置 timeoutMs 时两段同值。
 */
export const DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS = 120_000;

/**
 * transform 场景（summary / trim+summary 等连续性变换）的模型调用预算。
 * 非流式摘要在整个结果生成完之前收不到响应头，需要远宽于对话默认的空闲
 * 时限；装配层为摘要类实例显式设置此值（LLM 实例=参数快照，场景差异用
 * 不同实例表达），llm 层 headersTimeout 亦锚定此值。
 */
export const TRANSFORM_MODEL_TIMEOUT_MS = 600_000;

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

/** 空闲时限句柄：signal 供请求与流读取使用，touch 在每次远端活动时调用 */
export interface IdleDeadlineHandle {
  signal: AbortSignal | undefined;
  /** 收到远端活动（响应头、新 attempt 开始）时调用，重置当前段的空闲计时 */
  touch: () => void;
  /**
   * 收到流式数据 / 响应体数据时调用：首次调用把计时从首段预算
   * （firstTokenMs）切换到间隔预算（timeoutMs），之后等同 touch
   */
  touchData: () => void;
}

/**
 * 合并外部中断信号与空闲时限为单一 AbortSignal。
 *
 * - 空闲语义（两段预算）：计时从创建时刻起算按首段预算（firstTokenMs，缺省
 *   等于 timeoutMs）执行，首个数据 touchData() 后切换为间隔预算；每次 touch() /
 *   touchData() 重置计时；持续对应预算无任何重置才判定连接断开并以 TimeoutError
 *   DOMException 中止，上游经 throwIfAborted 按 TimeoutError 传播（不参与客户端
 *   重试；classifyAPIError 归入 connection_timeout，冒泡后由宿主续段策略接管）。
 * - timeoutMs 为 undefined / Infinity 时仅透传外部信号（不额外建 controller）。
 * - firstTokenMs 为 undefined / 非法时退化为单值行为（两段同用 timeoutMs）。
 */
export function withIdleDeadline(
  signal: AbortSignal | undefined,
  timeoutMs?: number,
  firstTokenMs?: number,
): IdleDeadlineHandle {
  if (!timeoutMs || timeoutMs === Infinity || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal, touch: () => {}, touchData: () => {} };
  }
  const intervalMs = timeoutMs;
  const initialMs =
    firstTokenMs !== undefined && Number.isFinite(firstTokenMs) && firstTokenMs > 0
      ? firstTokenMs
      : intervalMs;
  const merged = new AbortController();
  let currentMs = initialMs;
  const onTimeout = () =>
    merged.abort(new DOMException(`Model call deadline exceeded: no data received for ${currentMs}ms`, 'TimeoutError'));
  let timer = setTimeout(onTimeout, currentMs);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(onTimeout, currentMs);
  };
  const touch = () => {
    if (merged.signal.aborted) return;
    arm();
  };
  const touchData = () => {
    if (merged.signal.aborted) return;
    currentMs = intervalMs;
    arm();
  };
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      merged.abort(signal.reason);
      return { signal: merged.signal, touch, touchData };
    }
    const onExternalAbort = () => merged.abort(signal.reason);
    signal.addEventListener('abort', onExternalAbort, { once: true });
    // 外部 signal 通常是长期存活的 agent signal：deadline 到点后必须解除上面的
    // listener，否则每次模型调用都会在外部 signal 上累积一个监听
    // （MaxListenersExceededWarning / EventTarget 泄漏）。merged 中止（含空闲
    // 超时触发）时同步清掉 pending 定时器，避免悬挂的 timer 拖住事件循环。
    merged.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onExternalAbort);
    }, { once: true });
  }
  return { signal: merged.signal, touch, touchData };
}

/**
 * signal 已中止时抛出对应错误，未中止则静默返回。
 *
 * 区分两种中止来源：
 * - deadline 空闲超时（reason 为 withIdleDeadline 产出的 TimeoutError
 *   DOMException）→ 抛出 reason 本身：不参与客户端重试（shouldRetry 不认），
 *   但 classifyAPIError 归入 connection_timeout（retryable），冒泡到 Call
 *   终态后由宿主续段策略（force-continuation 等）接管；
 * - 外部中止（用户取消等）→ 抛 AbortError，按中断处理直接传播、永不续段。
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    throw reason;
  }
  throw new DOMException('Aborted', 'AbortError');
}

/**
 * 从 ModelConfig 解析生效的重试上限与空闲时限，缺省时填充框架默认值。
 *
 * timeoutMs 显式配置时管两段（首段预算 = 间隔预算）；缺省时首段独立取
 * DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS、间隔取 DEFAULT_MODEL_TIMEOUT_MS。
 * 显式非法值不透传（两段一并关闭，落回框架行为见调用方），不放大成无超时保护。
 */
export function resolveModelCallPolicy(config?: { maxRetries?: number; timeoutMs?: number }): {
  maxRetries: number;
  timeoutMs: number | undefined;
  firstTokenTimeoutMs: number | undefined;
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
  const firstTokenTimeoutMs =
    config?.timeoutMs !== undefined ? timeoutMs : DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS;
  return { maxRetries, timeoutMs, firstTokenTimeoutMs };
}
