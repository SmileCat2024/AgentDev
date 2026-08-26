import { describe, it, expect } from 'vitest';
import {
  OpenAILLM,
  createOpenAILLM,
  createAnthropicLLM,
  createOpenAIResponsesLLM,
} from '../src/index.js';
import { DEFAULT_MODEL_MAX_RETRIES, DEFAULT_MODEL_TIMEOUT_MS } from '@agentdevjs/core';

const MODEL_CONFIG_BASE = {
  apiKey: 'test-key',
  model: 'test-model',
};

describe('model call policy consumption', () => {
  it('fills defaults when ModelConfig omits maxRetries/timeoutMs', () => {
    const llm = createOpenAILLM({ ...MODEL_CONFIG_BASE });
    expect((llm as any).maxRetries).toBe(DEFAULT_MODEL_MAX_RETRIES);
    expect((llm as any).deadlineMs).toBe(DEFAULT_MODEL_TIMEOUT_MS);
  });

  it('consumes explicit maxRetries and timeoutMs from ModelConfig (openai)', () => {
    const llm = createOpenAILLM({ ...MODEL_CONFIG_BASE, maxRetries: 2, timeoutMs: 60000 });
    expect((llm as any).maxRetries).toBe(2);
    expect((llm as any).deadlineMs).toBe(60000);
  });

  it('consumes policy from AgentConfigFile.defaultModel (anthropic)', () => {
    const config = {
      defaultModel: { ...MODEL_CONFIG_BASE, maxRetries: 1, timeoutMs: 30000 },
    };
    const llm = createAnthropicLLM(config as any);
    expect((llm as any).maxRetries).toBe(1);
    expect((llm as any).deadlineMs).toBe(30000);
  });

  it('consumes policy via ModelConfig (openai-responses)', () => {
    const llm = createOpenAIResponsesLLM({ ...MODEL_CONFIG_BASE, maxRetries: 0, timeoutMs: 1000 });
    expect((llm as any).maxRetries).toBe(0);
    expect((llm as any).deadlineMs).toBe(1000);
  });

  it('keeps constructor signature path working without policy', () => {
    const llm = new OpenAILLM('test-key', 'test-model', 'https://mock.local/v1');
    expect((llm as any).maxRetries).toBe(DEFAULT_MODEL_MAX_RETRIES);
    expect((llm as any).deadlineMs).toBe(DEFAULT_MODEL_TIMEOUT_MS);
  });
});
