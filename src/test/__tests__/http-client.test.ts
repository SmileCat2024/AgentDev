import { describe, expect, it } from 'vitest';
import {
  HTTP_CONNECT_TIMEOUT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
  buildHttpDispatcherOptions,
  isExternallyManagedDispatcher,
} from '../../llm/http-client.js';

describe('llm http client ownership and timeouts', () => {
  it('uses Undici connector and response-header timeout fields', () => {
    const options = buildHttpDispatcherOptions('localhost,127.0.0.1');

    expect(options).toEqual({
      noProxy: 'localhost,127.0.0.1',
      headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
      connect: { timeout: HTTP_CONNECT_TIMEOUT_MS },
    });
    expect(options).not.toHaveProperty('connectTimeout');
    expect(options.connect).not.toHaveProperty('connectTimeout');
  });

  it('recognizes a dispatcher installed by the embedding host', () => {
    const initial = {};
    expect(isExternallyManagedDispatcher(initial, initial)).toBe(false);
    expect(isExternallyManagedDispatcher({}, initial)).toBe(true);
  });
});
