import { describe, it, expect } from 'vitest';
import {
  classifyAPIError,
  getUserFriendlyMessage,
  extractConnectionErrorDetails,
  classifyAndWrapError,
  ClassifiedAPIError,
} from '../../llm/api-errors.js';

/** Helper: create an Error with code */
function errWithCode(message: string, code: string, hostname?: string): Error {
  const e = new Error(message) as any;
  e.code = code;
  if (hostname) e.hostname = hostname;
  return e;
}

/** Helper: create an Error with a cause chain */
function errWithCause(message: string, cause: Error): Error {
  const e = new Error(message);
  e.cause = cause;
  return e;
}

describe('api-errors', () => {
  // ========== classifyAPIError: HTTP status ==========

  describe('classifyAPIError - HTTP status', () => {
    it('should classify 429 as rate_limit', () => {
      expect(classifyAPIError(null, 429)).toBe('rate_limit');
    });

    it('should classify 529 as server_overload', () => {
      expect(classifyAPIError(null, 529)).toBe('server_overload');
    });

    it('should classify 401 as auth_error', () => {
      expect(classifyAPIError(null, 401)).toBe('auth_error');
    });

    it('should classify 403 as auth_error', () => {
      expect(classifyAPIError(null, 403)).toBe('auth_error');
    });

    it('should classify 5xx (non-529) as server_error', () => {
      expect(classifyAPIError(null, 500)).toBe('server_error');
      expect(classifyAPIError(null, 502)).toBe('server_error');
      expect(classifyAPIError(null, 503)).toBe('server_error');
    });

    it('should classify 4xx (non-specific) as client_error', () => {
      expect(classifyAPIError(null, 400)).toBe('client_error');
      expect(classifyAPIError(null, 404)).toBe('client_error');
      expect(classifyAPIError(null, 422)).toBe('client_error');
    });
  });

  // ========== classifyAPIError: message matching ==========

  describe('classifyAPIError - overloaded_error message', () => {
    it('should classify overloaded_error message as server_overload', () => {
      const err = new Error('{"type":"overloaded_error"}');
      expect(classifyAPIError(err)).toBe('server_overload');
    });
  });

  // ========== classifyAPIError: connection details ==========

  describe('classifyAPIError - SSL errors', () => {
    it('should classify CERT_HAS_EXPIRED as ssl_cert_error', () => {
      expect(classifyAPIError(errWithCode('cert expired', 'CERT_HAS_EXPIRED'))).toBe('ssl_cert_error');
    });

    it('should classify DEPTH_ZERO_SELF_SIGNED_CERT as ssl_cert_error', () => {
      expect(classifyAPIError(errWithCode('self-signed', 'DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('ssl_cert_error');
    });

    it('should classify EPROTO as ssl_cert_error', () => {
      expect(classifyAPIError(errWithCode('proto error', 'EPROTO'))).toBe('ssl_cert_error');
    });
  });

  describe('classifyAPIError - DNS errors', () => {
    it('should classify ENOTFOUND as connection_error', () => {
      expect(classifyAPIError(errWithCode('not found', 'ENOTFOUND'))).toBe('connection_error');
    });

    it('should classify EAI_AGAIN as connection_error', () => {
      expect(classifyAPIError(errWithCode('again', 'EAI_AGAIN'))).toBe('connection_error');
    });
  });

  describe('classifyAPIError - timeout errors', () => {
    it('should classify ETIMEDOUT as connection_timeout', () => {
      expect(classifyAPIError(errWithCode('timed out', 'ETIMEDOUT'))).toBe('connection_timeout');
    });

    it('should classify UND_ERR_CONNECT_TIMEOUT as connection_timeout', () => {
      expect(classifyAPIError(errWithCode('timeout', 'UND_ERR_CONNECT_TIMEOUT'))).toBe('connection_timeout');
    });
  });

  describe('classifyAPIError - SDK network wrappers', () => {
    it('should classify the OpenAI SDK connection wrapper', () => {
      expect(classifyAPIError(new Error('Connection error.'))).toBe('connection_error');
    });

    it('should classify the OpenAI SDK timeout wrapper', () => {
      expect(classifyAPIError(new Error('Request timed out.'))).toBe('connection_timeout');
    });
  });

  describe('classifyAPIError - connection errors', () => {
    it('should classify ECONNRESET as connection_error', () => {
      expect(classifyAPIError(errWithCode('reset', 'ECONNRESET'))).toBe('connection_error');
    });

    it('should classify ECONNREFUSED as connection_error', () => {
      expect(classifyAPIError(errWithCode('refused', 'ECONNREFUSED'))).toBe('connection_error');
    });
  });

  describe('classifyAPIError - cause chain', () => {
    it('should traverse cause chain to find code', () => {
      const inner = errWithCode('inner', 'ECONNRESET');
      const outer = errWithCause('outer', inner);
      expect(classifyAPIError(outer)).toBe('connection_error');
    });
  });

  // ========== classifyAPIError: keyword matching ==========

  describe('classifyAPIError - keyword matching', () => {
    it('should classify "prompt is too long" as prompt_too_long', () => {
      expect(classifyAPIError(new Error('The prompt is too long'))).toBe('prompt_too_long');
    });

    it('should classify "maximum context length" as prompt_too_long', () => {
      expect(classifyAPIError(new Error('This exceeds the maximum context length'))).toBe('prompt_too_long');
    });

    it('should classify "invalid api key" as invalid_api_key', () => {
      expect(classifyAPIError(new Error('Invalid API key provided'))).toBe('invalid_api_key');
    });

    it('should classify "fetch failed" as connection_error', () => {
      expect(classifyAPIError(new Error('fetch failed'))).toBe('connection_error');
    });

    it('should classify "timeout" keyword as connection_timeout', () => {
      expect(classifyAPIError(new Error('Request timeout'))).toBe('connection_timeout');
    });

    it('should classify unknown error as unknown', () => {
      expect(classifyAPIError(new Error('something weird'))).toBe('unknown');
    });
  });

  // ========== extractConnectionErrorDetails ==========

  describe('extractConnectionErrorDetails', () => {
    it('should extract details from error with code', () => {
      const err = errWithCode('cert expired', 'CERT_HAS_EXPIRED', 'api.example.com');
      const details = extractConnectionErrorDetails(err);
      expect(details).not.toBeNull();
      expect(details!.code).toBe('CERT_HAS_EXPIRED');
      expect(details!.hostname).toBe('api.example.com');
      expect(details!.isSSLError).toBe(true);
    });

    it('should detect DNS errors', () => {
      const details = extractConnectionErrorDetails(errWithCode('dns', 'ENOTFOUND'));
      expect(details!.isDNSError).toBe(true);
      expect(details!.isSSLError).toBe(false);
    });

    it('should detect timeout errors', () => {
      const details = extractConnectionErrorDetails(errWithCode('timeout', 'ETIMEDOUT'));
      expect(details!.isTimeoutError).toBe(true);
    });

    it('should traverse cause chain', () => {
      const inner = errWithCode('inner', 'ECONNRESET');
      const outer = errWithCause('outer', inner);
      const details = extractConnectionErrorDetails(outer);
      expect(details!.code).toBe('ECONNRESET');
    });

    it('should return null for non-object', () => {
      expect(extractConnectionErrorDetails(null)).toBeNull();
      expect(extractConnectionErrorDetails('string')).toBeNull();
    });

    it('should return null for error without code', () => {
      expect(extractConnectionErrorDetails(new Error('no code'))).toBeNull();
    });
  });

  // ========== getUserFriendlyMessage ==========

  describe('getUserFriendlyMessage', () => {
    it('should return message for rate_limit', () => {
      const msg = getUserFriendlyMessage('rate_limit', new Error('test'));
      expect(msg).toContain('429');
    });

    it('should return message for server_overload', () => {
      const msg = getUserFriendlyMessage('server_overload', new Error('test'));
      expect(msg).toContain('529');
    });

    it('should return message for auth_error', () => {
      const msg = getUserFriendlyMessage('auth_error', new Error('test'), 401);
      expect(msg).toContain('认证');
    });

    it('should return message for prompt_too_long', () => {
      const msg = getUserFriendlyMessage('prompt_too_long', new Error('test'));
      expect(msg).toContain('超长');
    });

    it('should include hostname for DNS errors', () => {
      const err = errWithCode('dns fail', 'ENOTFOUND', 'api.openai.com');
      const msg = getUserFriendlyMessage('connection_error', err);
      expect(msg).toContain('api.openai.com');
    });

    it('should sanitize HTML error messages', () => {
      const html = '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head></html>';
      const msg = getUserFriendlyMessage('unknown', new Error(html));
      expect(msg).toContain('502 Bad Gateway');
      expect(msg).not.toContain('<');
    });

    it('should truncate very long messages', () => {
      const longMsg = 'x'.repeat(500);
      const msg = getUserFriendlyMessage('unknown', new Error(longMsg));
      expect(msg.length).toBeLessThan(longMsg.length);
      expect(msg).toContain('...');
    });
  });

  // ========== classifyAndWrapError ==========

  describe('classifyAndWrapError', () => {
    it('should create ClassifiedAPIError with correct properties', () => {
      const original = new Error('rate limited');
      const wrapped = classifyAndWrapError(original, 429);
      expect(wrapped).toBeInstanceOf(ClassifiedAPIError);
      expect(wrapped.errorType).toBe('rate_limit');
      expect(wrapped.originalError).toBe(original);
      expect(wrapped.statusCode).toBe(429);
      expect(wrapped.userMessage).toContain('429');
    });

    it('should wrap non-Error inputs', () => {
      const wrapped = classifyAndWrapError('just a string', 500);
      expect(wrapped).toBeInstanceOf(ClassifiedAPIError);
      expect(wrapped.errorType).toBe('server_error');
      expect(wrapped.originalError).toBeInstanceOf(Error);
    });

    it('should preserve cause chain', () => {
      const original = errWithCode('reset', 'ECONNRESET');
      const wrapped = classifyAndWrapError(original);
      expect(wrapped.cause).toBe(original);
    });
  });
});
