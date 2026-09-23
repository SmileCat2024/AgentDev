import { describe, expect, it } from 'vitest';
import {
  normalizeApiBaseUrl,
  resolveAnthropicMessagesUrl,
  stripEndpointSuffixes,
} from '../src/api-url.js';

describe('stripEndpointSuffixes', () => {
  it('strips full chat-completions endpoints down to the API root', () => {
    expect(stripEndpointSuffixes('https://api.xiaomimimo.com/v1/chat/completions')).toBe('https://api.xiaomimimo.com/v1');
  });

  it('strips responses and messages endpoints', () => {
    expect(stripEndpointSuffixes('https://api.example.com/v1/responses')).toBe('https://api.example.com/v1');
    expect(stripEndpointSuffixes('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1');
    expect(stripEndpointSuffixes('https://api.example.com/messages')).toBe('https://api.example.com');
  });

  it('strips repeated or trailing-slash variants', () => {
    expect(stripEndpointSuffixes('https://api.example.com/v1/chat/completions/')).toBe('https://api.example.com/v1');
    expect(stripEndpointSuffixes('https://api.example.com/chat/completions/chat/completions')).toBe('https://api.example.com');
  });

  it('leaves plain API roots untouched', () => {
    expect(stripEndpointSuffixes('https://api.anthropic.com')).toBe('https://api.anthropic.com');
    expect(stripEndpointSuffixes('https://open.bigmodel.cn/api/anthropic')).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(stripEndpointSuffixes('https://x.openai.azure.com/openai/deployments/gpt-4o')).toBe('https://x.openai.azure.com/openai/deployments/gpt-4o');
    expect(stripEndpointSuffixes('https://opencode.ai/zen/v1')).toBe('https://opencode.ai/zen/v1');
  });
});

describe('normalizeApiBaseUrl', () => {
  it('returns undefined for empty input so SDK defaults apply', () => {
    expect(normalizeApiBaseUrl(undefined)).toBeUndefined();
    expect(normalizeApiBaseUrl('')).toBeUndefined();
    expect(normalizeApiBaseUrl('   ')).toBeUndefined();
  });

  it('normalizes a stored full endpoint for SDK consumption', () => {
    expect(normalizeApiBaseUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1');
  });
});

describe('resolveAnthropicMessagesUrl', () => {
  it('appends /v1/messages to a bare root', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages');
  });

  it('appends only /messages when the root already ends with a version segment', () => {
    expect(resolveAnthropicMessagesUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/messages');
  });

  it('is idempotent when the stored URL already contains the endpoint', () => {
    expect(resolveAnthropicMessagesUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1/messages');
    expect(resolveAnthropicMessagesUrl('https://api.example.com/messages')).toBe('https://api.example.com/v1/messages');
  });
});
