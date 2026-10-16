import { describe, expect, it } from 'vitest';
import { TRANSFORM_MODEL_TIMEOUT_MS } from '@agentdevjs/core';
import {
  HTTP_BODY_TIMEOUT_MS,
  HTTP_CONNECT_TIMEOUT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
  buildHttpDispatcherOptions,
  isExternallyManagedDispatcher,
} from '../../src/http-client.js';

describe('llm http client ownership and timeouts', () => {
  it('uses Undici connector and response-header timeout fields', () => {
    const options = buildHttpDispatcherOptions('localhost,127.0.0.1');

    expect(options).toEqual({
      noProxy: 'localhost,127.0.0.1',
      headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
      bodyTimeout: HTTP_BODY_TIMEOUT_MS,
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

  it('aligns transport timeouts with the model-call idle deadline semantics', () => {
    // 非流式（transform 摘要）：响应头要等服务端生成完整个结果才发出，
    // headersTimeout 事实上是"非流式总等待预算"，必须 ≥ 场景最大 idle deadline
    // （TRANSFORM_MODEL_TIMEOUT_MS），否则较短的一侧会先掐断等待，另一侧的
    // 语义形同虚设。对话默认 idle（DEFAULT_MODEL_TIMEOUT_MS=60s）必先于该值。
    expect(HTTP_HEADERS_TIMEOUT_MS).toBe(TRANSFORM_MODEL_TIMEOUT_MS);
    expect(HTTP_HEADERS_TIMEOUT_MS).toBe(600_000);
    // 流式：chunk 间持续 60s 无数据即判定断流（与对话默认 idle 同值，可重试）。
    expect(HTTP_BODY_TIMEOUT_MS).toBe(60_000);
  });
});
