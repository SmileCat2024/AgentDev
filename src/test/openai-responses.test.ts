import { describe, it, expect } from 'vitest';
import { compileContextForOpenAIResponses, OpenAIResponsesLLM } from '../llm/openai-responses.js';
import { parseRetryAfter } from '../llm/retry.js';
import type { Message, Tool } from '../core/types.js';

const tools: Tool[] = [
  {
    name: 'weather',
    description: 'Get weather',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string' },
      },
      required: ['city'],
    },
    async execute() {
      return {};
    },
  },
];

describe('OpenAI Responses compilation', () => {
  it('should compile a simple conversation', () => {
    const messages: Message[] = [
      { role: 'system', content: '你是一个助手。' },
      { role: 'user', content: '上海天气如何？' },
    ];

    const compiled = compileContextForOpenAIResponses(messages, tools, { modelName: 'gpt-5.5', maxTokens: 512 });

    expect(compiled.model).toBe('gpt-5.5');
    expect(Array.isArray(compiled.input)).toBe(true);
    expect(compiled.input).toHaveLength(2);
    expect(compiled.tools).toHaveLength(1);
    expect(compiled.max_output_tokens).toBe(512);
  });

  it('should compile tool calls and assistant history with reasoning', () => {
    const messages: Message[] = [
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: '我先查一下。',
        reasoning: '要调用天气工具。',
        toolCalls: [{ id: 'tool_1', name: 'weather', arguments: { city: 'Shanghai' } }],
      },
      { role: 'tool', content: '{"success":true,"result":"18°C"}', toolCallId: 'tool_1' },
    ];

    const compiled = compileContextForOpenAIResponses(messages, tools, { modelName: 'gpt-5.5' });

    const functionCallOutput = compiled.input.find((item) => item.type === 'function_call_output');
    const functionCall = compiled.input.find((item) => item.type === 'function_call');

    expect(functionCallOutput).toBeDefined();
    expect(functionCallOutput.call_id).toBe('tool_1');
    expect(compiled.input.some((item) => item.type === 'reasoning')).toBe(true);
    expect(functionCall).toBeDefined();
    expect(functionCall.call_id).toBe('tool_1');
    expect('id' in functionCall).toBe(false);
    expect('status' in functionCall).toBe(false);
  });

  it('should not invent output item ids for assistant text history', () => {
    const messages: Message[] = [
      { role: 'user', content: '你好，你是谁' },
      { role: 'assistant', content: '你好，我是一个 AI 助手。' },
      { role: 'user', content: '你是什么模型' },
    ];

    const compiled = compileContextForOpenAIResponses(messages, tools, { modelName: 'gpt-5.5' });
    const assistantMessage = compiled.input.find((item) => item.type === 'message' && item.role === 'assistant');

    expect(assistantMessage).toBeDefined();
    expect('id' in assistantMessage).toBe(false);
    expect('status' in assistantMessage).toBe(false);
  });

  it('should compile the strict ChatGPT Codex Responses contract', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Primary identity' },
      { role: 'system', content: 'Feature reminder', source: 'handoff-seed' },
      { role: 'user', content: 'Hello' },
    ];

    const compiled = compileContextForOpenAIResponses(messages, tools, {
      modelName: 'gpt-5.6-sol',
      maxTokens: 400_000,
      responsesProfile: 'codex',
      providerOptions: {
        instructions: 'must not override runtime instructions',
        store: true,
        input: [],
      },
    });

    expect(compiled.instructions).toBe('Primary identity');
    expect(compiled.store).toBe(false);
    expect(compiled.max_output_tokens).toBeUndefined();
    expect(compiled.input).toHaveLength(2);
    expect(compiled.input[0].role).toBe('user');
    expect(compiled.input[0].content[0].text).toBe('Feature reminder');
    expect(compiled.input[1].role).toBe('user');
    expect(compiled.tool_choice).toBe('auto');
    expect(compiled.parallel_tool_calls).toBe(true);
  });

  it('should provide non-empty Codex instructions when no system message exists', () => {
    const compiled = compileContextForOpenAIResponses(
      [{ role: 'user', content: 'Hello' }],
      [],
      { modelName: 'gpt-5.6-sol', responsesProfile: 'codex' },
    );

    expect(compiled.instructions).toBeTruthy();
    expect(compiled.store).toBe(false);
    expect(compiled.input).toHaveLength(1);
  });

  it('should preserve the standard Responses request shape by default', () => {
    const compiled = compileContextForOpenAIResponses(
      [{ role: 'system', content: 'Standard system message' }, { role: 'user', content: 'Hello' }],
      [],
      { modelName: 'gpt-5.6' },
    );

    expect(compiled.instructions).toBeUndefined();
    expect(compiled.store).toBeUndefined();
    expect(compiled.input[0].role).toBe('system');
  });
});

describe('parseRetryAfter', () => {
  it('should accept plain SDK header objects case-insensitively', () => {
    expect(parseRetryAfter({ 'retry-after': '2' })).toBe(2000);
    expect(parseRetryAfter({ 'Retry-After': '3' })).toBe(3000);
  });
});

describe('OpenAIResponsesLLM fallback', () => {
  it('should preserve streamed text when Codex sends a sparse completed snapshot', async () => {
    const llm = new OpenAIResponsesLLM(
      'test-api-key',
      'gpt-5.6-sol',
      'https://example.com/backend-api/codex',
      400_000,
      undefined,
      undefined,
      undefined,
      false,
      'codex',
    );

    (llm as any).client.responses.stream = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'response.output_text.delta', delta: 'OK' };
        yield {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [],
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          },
        };
      },
    });

    const result = await llm.chat(
      [{ role: 'system', content: 'Probe' }, { role: 'user', content: 'Reply OK' }],
      [],
    );

    expect(result.content).toBe('OK');
    expect(result.usage?.totalTokens).toBe(3);
  });

  it('should fall back to non-streaming on empty stream', async () => {
    const llm = new OpenAIResponsesLLM('test-api-key', 'gpt-5.5', 'https://example.com/v1');
    let streamCalls = 0;
    let createCalls = 0;

    (llm as any).client.responses.stream = () => {
      streamCalls += 1;
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(new Error('request ended without sending any events'));
            },
          };
        },
      };
    };

    (llm as any).client.responses.create = async () => {
      createCalls += 1;
      return {
        object: 'response',
        output_text: 'fallback ok',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'fallback ok',
              },
            ],
          },
        ],
        status: 'completed',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
        },
      };
    };

    const result = await llm.chat([{ role: 'user', content: 'hi' }], []);

    expect(result.content).toBe('fallback ok');
    expect(streamCalls).toBe(1);
    expect(createCalls).toBe(1);
  });
});
