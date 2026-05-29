/**
 * API 错误分类与用户友好消息
 *
 * 对标 Claude Code errors.ts + errorUtils.ts 的通用化实现：
 * - 标准错误分类（classifyAPIError）
 * - 用户友好消息映射（getUserFriendlyMessage）
 * - 连接错误详情提取（extractConnectionErrorDetails）
 * - 自定义 ClassifiedAPIError 异常类
 */

// ========== 错误类型枚举 ==========

export type APIErrorType =
  | 'connection_error'       // DNS/网络连接错误 (ENOTFOUND, ECONNREFUSED, ECONNRESET...)
  | 'connection_timeout'     // 连接超时 (ETIMEDOUT, UND_ERR_CONNECT_TIMEOUT...)
  | 'rate_limit'             // HTTP 429 限流
  | 'server_overload'        // HTTP 529 服务过载 / overloaded_error
  | 'server_error'           // HTTP 5xx 服务端错误
  | 'client_error'           // HTTP 4xx 客户端错误（非特定）
  | 'auth_error'             // HTTP 401/403 认证失败
  | 'prompt_too_long'        // 提示词/token 超长
  | 'invalid_api_key'        // API Key 无效
  | 'ssl_cert_error'         // SSL/TLS 证书错误
  | 'unknown';               // 未知错误

// ========== 自定义异常类 ==========

/**
 * 分类后的 API 错误
 *
 * 携带标准化的 errorType 和用户友好的 userMessage，
 * 上层（react-loop、UI）可据此展示不同级别的提示。
 */
export class ClassifiedAPIError extends Error {
  readonly errorType: APIErrorType;
  readonly userMessage: string;
  readonly originalError: Error;
  readonly statusCode?: number;

  constructor(
    errorType: APIErrorType,
    userMessage: string,
    originalError: Error,
    statusCode?: number,
  ) {
    super(userMessage);
    this.name = 'ClassifiedAPIError';
    this.errorType = errorType;
    this.userMessage = userMessage;
    this.originalError = originalError;
    this.statusCode = statusCode;
    this.cause = originalError;
  }
}

// ========== SSL/TLS 错误码（来自 OpenSSL） ==========

const SSL_ERROR_CODES: ReadonlySet<string> = new Set([
  // 证书验证错误
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  // 自签名证书
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  // 证书链错误
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  // 主机名/altname 错误
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  // TLS 握手错误
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  // EPROTO（通常也是 SSL 问题）
  'EPROTO',
]);

// ========== DNS/连接错误码 ==========

const DNS_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EAI_NODATA',
]);

const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNABORTED',
]);

const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

// ========== 连接错误详情提取 ==========

export interface ConnectionErrorDetails {
  code: string;
  message: string;
  hostname?: string;
  isSSLError: boolean;
  isDNSError: boolean;
  isTimeoutError: boolean;
}

/**
 * 从错误 cause 链中提取连接错误详情
 *
 * 遍历 error.cause 链（最多5层），找到第一个有 code 属性的节点。
 */
export function extractConnectionErrorDetails(
  error: unknown,
): ConnectionErrorDetails | null {
  if (!error || typeof error !== 'object') return null;

  let current: unknown = error;
  const maxDepth = 5;
  let depth = 0;

  while (current && depth < maxDepth) {
    if (
      current instanceof Error &&
      'code' in current &&
      typeof (current as any).code === 'string'
    ) {
      const code = (current as any).code as string;
      const message = current.message || '';
      const hostname = (current as any).hostname as string | undefined;
      return {
        code,
        message,
        hostname,
        isSSLError: SSL_ERROR_CODES.has(code),
        isDNSError: DNS_ERROR_CODES.has(code),
        isTimeoutError: TIMEOUT_ERROR_CODES.has(code),
      };
    }

    if (
      current instanceof Error &&
      'cause' in current &&
      (current as any).cause !== current
    ) {
      current = (current as any).cause;
      depth++;
    } else {
      break;
    }
  }

  return null;
}

// ========== 错误分类 ==========

/**
 * 将任意 API 错误分类为标准化的 APIErrorType
 *
 * 分类优先级（对标 Claude Code classifyAPIError）：
 * 1. HTTP 状态码（429/529/401/403/5xx/4xx）
 * 2. overloaded_error 消息匹配（流式 529 可能丢失状态码）
 * 3. 连接错误详情（SSL/DNS/Timeout/Connection）
 * 4. 消息关键字匹配（prompt_too_long, invalid_api_key 等）
 * 5. 兜底 unknown
 */
export function classifyAPIError(error: unknown, status?: number): APIErrorType {
  // --- 1. 基于 HTTP 状态码 ---

  // 429 限流
  if (status === 429) return 'rate_limit';

  // 529 服务过载
  if (status === 529) return 'server_overload';

  // 401/403 认证失败
  if (status === 401 || status === 403) return 'auth_error';

  // 5xx 服务端错误
  if (status !== undefined && status >= 500) return 'server_error';

  // 4xx 客户端错误（非特定）
  if (status !== undefined && status >= 400) return 'client_error';

  // --- 2. overloaded_error 消息匹配 ---
  if (
    error instanceof Error &&
    error.message.includes('"type":"overloaded_error"')
  ) {
    return 'server_overload';
  }

  // --- 3. 连接错误详情 ---
  const connDetails = extractConnectionErrorDetails(error);
  if (connDetails) {
    if (connDetails.isSSLError) return 'ssl_cert_error';
    if (connDetails.isDNSError) return 'connection_error';
    if (connDetails.isTimeoutError) return 'connection_timeout';
    if (CONNECTION_ERROR_CODES.has(connDetails.code)) return 'connection_error';
  }

  // --- 4. 消息关键字匹配 ---

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // 提示词过长
    if (
      msg.includes('prompt is too long') ||
      msg.includes('prompt too long') ||
      msg.includes('maximum context length') ||
      msg.includes('token limit') ||
      msg.includes('context window')
    ) {
      return 'prompt_too_long';
    }

    // API Key 无效
    if (msg.includes('invalid api key') || msg.includes('invalid x-api-key')) {
      return 'invalid_api_key';
    }

    // fetch failed（Undici 通用网络错误包装）
    if (msg.includes('fetch failed')) return 'connection_error';

    // 超时关键字
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return 'connection_timeout';
    }
  }

  // --- 5. 兜底 ---
  return 'unknown';
}

// ========== 用户友好消息映射 ==========

/**
 * 根据错误类型生成用户友好的中文消息
 *
 * 对标 Claude Code getAssistantMessageFromError / formatAPIError，
 * 但使用中文且去掉 Max/Pro/Enterprise 等订阅相关逻辑。
 */
export function getUserFriendlyMessage(
  errorType: APIErrorType,
  error: Error,
  status?: number,
): string {
  const connDetails = extractConnectionErrorDetails(error);

  switch (errorType) {
    case 'connection_error': {
      if (connDetails) {
        // DNS 解析失败
        if (connDetails.isDNSError) {
          const host = connDetails.hostname || '服务器';
          return `无法连接到 API 服务器 (${host})：DNS 解析失败，请检查网络连接或 API 地址配置`;
        }
        // 连接被拒绝/重置
        if (CONNECTION_ERROR_CODES.has(connDetails.code)) {
          const host = connDetails.hostname || '';
          return `网络连接错误 (${connDetails.code})${host ? `，目标: ${host}` : ''}，请检查网络连接或代理设置`;
        }
      }
      return '无法连接到 API 服务器，请检查网络连接';
    }

    case 'connection_timeout': {
      if (connDetails) {
        return `请求超时 (${connDetails.code})，请检查网络连接或代理设置`;
      }
      return '请求超时，请检查网络连接';
    }

    case 'ssl_cert_error': {
      if (connDetails) {
        switch (connDetails.code) {
          case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
          case 'UNABLE_TO_GET_ISSUER_CERT':
          case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
            return 'SSL 证书验证失败，如果在使用企业代理，请设置 NODE_EXTRA_CA_CERTS 环境变量';
          case 'CERT_HAS_EXPIRED':
            return 'SSL 证书已过期';
          case 'SELF_SIGNED_CERT_IN_CHAIN':
          case 'DEPTH_ZERO_SELF_SIGNED_CERT':
            return '检测到自签名证书，请检查代理或企业 SSL 证书配置';
          case 'ERR_TLS_CERT_ALTNAME_INVALID':
          case 'HOSTNAME_MISMATCH':
            return 'SSL 证书主机名不匹配';
          case 'EPROTO':
            return 'SSL/TLS 协议错误，可能是代理或防火墙拦截了 HTTPS 连接';
          default:
            return `SSL 错误 (${connDetails.code})，请检查网络和证书配置`;
        }
      }
      return 'SSL 证书错误，请检查网络和证书配置';
    }

    case 'rate_limit':
      return 'API 请求频率超限 (429)，请稍后重试';

    case 'server_overload':
      return 'API 服务过载 (529)，请稍后重试';

    case 'server_error':
      return `API 服务端错误 (${status ?? '5xx'})，请稍后重试`;

    case 'auth_error':
      if (error.message.toLowerCase().includes('invalid api key') ||
          error.message.toLowerCase().includes('x-api-key')) {
        return 'API Key 无效，请检查配置中的 API Key';
      }
      return `认证失败 (${status ?? '401/403'})，请检查 API Key 或登录状态`;

    case 'invalid_api_key':
      return 'API Key 无效，请检查配置中的 API Key';

    case 'prompt_too_long':
      return '提示词/上下文超长，请减少对话内容或启用上下文压缩';

    case 'client_error':
      return `API 请求错误 (${status ?? '4xx'})：${sanitizeErrorMessage(error.message)}`;

    case 'unknown':
      return `API 调用失败：${sanitizeErrorMessage(error.message)}`;

    default:
      return `API 调用失败：${sanitizeErrorMessage(error.message)}`;
  }
}

// ========== 辅助函数 ==========

/**
 * 清理错误消息中的 HTML 内容（如 CloudFlare 错误页）
 */
function sanitizeErrorMessage(message: string): string {
  if (!message) return '未知错误';
  // 检测 HTML 内容
  if (message.includes('<!DOCTYPE html') || message.includes('<html')) {
    const titleMatch = message.match(/<title>([^<]+)<\/title>/);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim();
    }
    return '服务器返回了 HTML 错误页';
  }
  // 截断过长消息
  if (message.length > 300) {
    return message.slice(0, 300) + '...';
  }
  return message;
}

// ========== 顶层组合函数 ==========

/**
 * 对任意错误进行分类并生成 ClassifiedAPIError
 *
 * 这是最常用的入口函数，在 LLM catch 块中调用。
 */
export function classifyAndWrapError(
  error: unknown,
  status?: number,
): ClassifiedAPIError {
  const originalError = error instanceof Error ? error : new Error(String(error));
  const errorType = classifyAPIError(error, status);
  const userMessage = getUserFriendlyMessage(errorType, originalError, status);

  return new ClassifiedAPIError(errorType, userMessage, originalError, status);
}
