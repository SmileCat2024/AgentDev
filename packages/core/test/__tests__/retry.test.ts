import { describe, it, expect } from 'vitest';
import {
  parseRetryAfter,
  getRetryDelay,
  shouldRetry,
  extractErrorCode,
  sleep,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODEL_MAX_RETRIES,
  DEFAULT_MODEL_TIMEOUT_MS,
  resolveModelCallPolicy,
  withDeadline,
} from '../../src/core/retry.js';

describe('retry', () => {
  // ========== parseRetryAfter ==========

  describe('parseRetryAfter', () => {
    it('should parse seconds from Headers instance', () => {
      const headers = new Headers({ 'retry-after': '5' });
      expect(parseRetryAfter(headers)).toBe(5000);
    });

    it('should parse seconds from plain object', () => {
      const headers = { 'retry-after': '10' };
      expect(parseRetryAfter(headers)).toBe(10000);
    });

    it('should parse seconds from array header value', () => {
      const headers = { 'retry-after': ['3', '7'] };
      expect(parseRetryAfter(headers)).toBe(3000);
    });

    it('should return undefined for missing header', () => {
      expect(parseRetryAfter(new Headers())).toBeUndefined();
      expect(parseRetryAfter({})).toBeUndefined();
      expect(parseRetryAfter(undefined)).toBeUndefined();
    });

    it('should return undefined for non-numeric value', () => {
      expect(parseRetryAfter({ 'retry-after': 'abc' })).toBeUndefined();
    });

    it('should return undefined for zero or negative', () => {
      expect(parseRetryAfter({ 'retry-after': '0' })).toBeUndefined();
      expect(parseRetryAfter({ 'retry-after': '-5' })).toBeUndefined();
    });
  });

  // ========== getRetryDelay ==========

  describe('getRetryDelay', () => {
    it('should return Retry-After value when provided', () => {
      expect(getRetryDelay(1, 8000)).toBe(8000);
    });

    it('should ignore Retry-After when 0 or negative', () => {
      const delay = getRetryDelay(1, 0);
      expect(delay).toBeGreaterThan(0);
    });

    it('should produce exponential backoff for attempt 1', () => {
      // base = 500 * 2^0 = 500, jitter in [0, 125)
      const delay = getRetryDelay(1);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThan(625);
    });

    it('should produce exponential backoff for attempt 2', () => {
      // base = 500 * 2^1 = 1000, jitter in [0, 250)
      const delay = getRetryDelay(2);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThan(1250);
    });

    it('should produce exponential backoff for attempt 3', () => {
      // base = 500 * 2^2 = 2000, jitter in [0, 500)
      const delay = getRetryDelay(3);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThan(2500);
    });

    it('should cap at MAX_DELAY_MS (32000)', () => {
      // attempt 7+ => base = 500 * 2^6 = 32000
      const delay = getRetryDelay(7);
      expect(delay).toBeGreaterThanOrEqual(32000);
      expect(delay).toBeLessThan(40001); // 32000 + 25% = 40000
    });

    it('should not exceed base + 25% jitter', () => {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const delay = getRetryDelay(attempt);
        const base = Math.min(500 * Math.pow(2, attempt - 1), 32000);
        expect(delay).toBeLessThanOrEqual(base * 1.25);
      }
    });
  });

  // ========== shouldRetry ==========

  describe('shouldRetry', () => {
    it('should retry on 5xx errors', () => {
      expect(shouldRetry(null, 500)).toBe(true);
      expect(shouldRetry(null, 502)).toBe(true);
      expect(shouldRetry(null, 503)).toBe(true);
    });

    it('should retry on 408 Request Timeout', () => {
      expect(shouldRetry(null, 408)).toBe(true);
    });

    it('should retry on 409 Conflict', () => {
      expect(shouldRetry(null, 409)).toBe(true);
    });

    it('should retry on 429 Rate Limit', () => {
      expect(shouldRetry(null, 429)).toBe(true);
    });

    it('should retry on 529 Overloaded', () => {
      expect(shouldRetry(null, 529)).toBe(true);
    });

    it('should not retry on 400/401/403/404', () => {
      expect(shouldRetry(null, 400)).toBe(false);
      expect(shouldRetry(null, 401)).toBe(false);
      expect(shouldRetry(null, 403)).toBe(false);
      expect(shouldRetry(null, 404)).toBe(false);
    });

    it('should retry on overloaded_error in message', () => {
      const error = new Error('{"type":"overloaded_error","message":"Overloaded"}');
      expect(shouldRetry(error)).toBe(true);
    });

    it('should retry on retryable network error codes', () => {
      expect(shouldRetry(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe(true);
      expect(shouldRetry(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
      expect(shouldRetry(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(true);
      expect(shouldRetry(Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))).toBe(true);
    });

    it('should retry on Undici error codes', () => {
      expect(shouldRetry(Object.assign(new Error(), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe(true);
      expect(shouldRetry(Object.assign(new Error(), { code: 'UND_ERR_SOCKET' }))).toBe(true);
    });

    it('should traverse cause chain for error code', () => {
      const inner = Object.assign(new Error('inner'), { code: 'ECONNRESET' });
      const outer = new Error('outer');
      outer.cause = inner;
      expect(shouldRetry(outer)).toBe(true);
    });

    it('should not retry on unknown errors without status', () => {
      expect(shouldRetry(new Error('something went wrong'))).toBe(false);
      expect(shouldRetry(null)).toBe(false);
    });

    it('should export DEFAULT_MAX_RETRIES as 10', () => {
      expect(DEFAULT_MAX_RETRIES).toBe(10);
    });
  });

  // ========== extractErrorCode ==========

  describe('extractErrorCode', () => {
    it('should extract code from error', () => {
      const err = Object.assign(new Error('fail'), { code: 'ETIMEDOUT' });
      expect(extractErrorCode(err)).toBe('ETIMEDOUT');
    });

    it('should traverse cause chain', () => {
      const inner = Object.assign(new Error('inner'), { code: 'ECONNRESET' });
      const outer = new Error('outer');
      outer.cause = inner;
      expect(extractErrorCode(outer)).toBe('ECONNRESET');
    });

    it('should return undefined for non-Error', () => {
      expect(extractErrorCode(null)).toBeUndefined();
      expect(extractErrorCode('string')).toBeUndefined();
      expect(extractErrorCode(42)).toBeUndefined();
    });

    it('should return undefined when no code exists', () => {
      expect(extractErrorCode(new Error('no code'))).toBeUndefined();
    });

    it('should respect maxDepth of 5', () => {
      // Put the code at depth 6 (beyond maxDepth=5)
      const deepest = Object.assign(new Error('deepest'), { code: 'ECONNRESET' });
      let current: any = deepest;
      for (let i = 1; i <= 6; i++) {
        const next = new Error(`level${i}`);
        next.cause = current;
        current = next;
      }
      // current is outermost; code is 6 levels deep — unreachable
      expect(extractErrorCode(current)).toBeUndefined();
    });
  });

  // ========== sleep ==========

  describe('sleep', () => {
    it('should resolve after the specified duration', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it('should reject immediately if signal already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(sleep(100, controller.signal)).rejects.toThrow();
    });

    it('should reject when signal is aborted during sleep', async () => {
      const controller = new AbortController();
      const promise = sleep(5000, controller.signal);
      setTimeout(() => controller.abort(), 30);
      await expect(promise).rejects.toThrow();
    });
  });

  // ========== resolveModelCallPolicy ==========

  describe('resolveModelCallPolicy', () => {
    it('should fill defaults when config is missing', () => {
      expect(resolveModelCallPolicy()).toEqual({
        maxRetries: DEFAULT_MODEL_MAX_RETRIES,
        timeoutMs: DEFAULT_MODEL_TIMEOUT_MS,
      });
      expect(resolveModelCallPolicy(undefined)).toEqual({
        maxRetries: DEFAULT_MODEL_MAX_RETRIES,
        timeoutMs: DEFAULT_MODEL_TIMEOUT_MS,
      });
    });

    it('should fill only the missing side when partially configured', () => {
      const resolved = resolveModelCallPolicy({ maxRetries: 2 });
      expect(resolved.maxRetries).toBe(2);
      expect(resolved.timeoutMs).toBe(DEFAULT_MODEL_TIMEOUT_MS);

      const resolved2 = resolveModelCallPolicy({ timeoutMs: 60000 });
      expect(resolved2.maxRetries).toBe(DEFAULT_MODEL_MAX_RETRIES);
      expect(resolved2.timeoutMs).toBe(60000);
    });

    it('should floor fractional maxRetries', () => {
      expect(resolveModelCallPolicy({ maxRetries: 2.9 }).maxRetries).toBe(2);
    });

    it('should reject invalid maxRetries and fall back to default', () => {
      for (const invalid of [-1, NaN, Infinity]) {
        const resolved = resolveModelCallPolicy({ maxRetries: invalid });
        expect(resolved.maxRetries).toBe(DEFAULT_MODEL_MAX_RETRIES);
      }
    });

    it('should allow maxRetries 0 (no retry)', () => {
      expect(resolveModelCallPolicy({ maxRetries: 0 }).maxRetries).toBe(0);
    });

    it('should disable deadline when timeoutMs is invalid', () => {
      for (const invalid of [0, -1000, NaN, Infinity] as number[]) {
        expect(resolveModelCallPolicy({ timeoutMs: invalid }).timeoutMs).toBeUndefined();
      }
    });
  });

  // ========== withDeadline ==========

  describe('withDeadline', () => {
    it('should pass through when no timeout configured', () => {
      const controller = new AbortController();
      expect(withDeadline(controller.signal, undefined)).toBe(controller.signal);
      expect(withDeadline(controller.signal, Infinity)).toBe(controller.signal);
    });

    it('should create a standalone signal when only deadline given', () => {
      const signal = withDeadline(undefined, 60000)!;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });

    it('should abort with TimeoutError when deadline is reached', async () => {
      const signal = withDeadline(undefined, 30)!;
      const event = await new Promise<AbortSignal>((resolve) => {
        signal.addEventListener('abort', () => resolve(signal), { once: true });
      });
      expect(event.aborted).toBe(true);
      expect((event.reason as Error).name).toBe('TimeoutError');
    });

    it('should propagate external abort through merged signal', async () => {
      const controller = new AbortController();
      const signal = withDeadline(controller.signal, 60000)!;
      const reason = new Error('user interrupt');
      const event = await new Promise<AbortSignal>((resolve) => {
        signal.addEventListener('abort', () => resolve(signal), { once: true });
        controller.abort(reason);
      });
      expect(event.reason).toBe(reason);
    });

    it('should return already-aborted signal immediately', () => {
      const controller = new AbortController();
      const reason = new DOMException('Aborted', 'AbortError');
      controller.abort(reason);
      const signal = withDeadline(controller.signal, 60000)!;
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(reason);
    });
  });
});
