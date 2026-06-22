import { compileContextForOpenAIResponses, OpenAIResponsesLLM } from '../llm/openai-responses.js';
import { parseRetryAfter } from '../llm/retry.js';
import type { Message, Tool } from '../core/types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

function testCompileSimpleConversation(): void {
  const messages: Message[] = [
    { role: 'system', content: '你是一个助手。' },
    { role: 'user', content: '上海天气如何？' },
  ];

  const compiled = compileContextForOpenAIResponses(messages, tools, { modelName: 'gpt-5.5', maxTokens: 512 });

  assert(compiled.model === 'gpt-5.5', 'model should be preserved');
  assert(Array.isArray(compiled.input), 'input should be an array');
  assert(compiled.input.length === 2, 'system and user should compile into two message items');
  assert(compiled.tools?.length === 1, 'tool definition should be preserved');
  assert(compiled.max_output_tokens === 512, 'max token cap should be mapped');
}

function testCompileToolAndAssistantHistory(): void {
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
  assert(Boolean(functionCallOutput), 'tool result should compile to function_call_output');
  assert(functionCallOutput.call_id === 'tool_1', 'tool result should preserve call_id');
  assert(compiled.input.some((item) => item.type === 'reasoning'), 'assistant reasoning should be replayed');
  assert(Boolean(functionCall), 'assistant tool call should be replayed');
  assert(functionCall.call_id === 'tool_1', 'assistant tool call should preserve call_id');
  assert(!('id' in functionCall), 'assistant tool call history should not invent an output item id');
  assert(!('status' in functionCall), 'assistant tool call history should not invent an output item status');
}

function testAssistantTextHistoryAvoidsGeneratedOutputIds(): void {
  const messages: Message[] = [
    { role: 'user', content: '你好，你是谁' },
    { role: 'assistant', content: '你好，我是一个 AI 助手。' },
    { role: 'user', content: '你是什么模型' },
  ];

  const compiled = compileContextForOpenAIResponses(messages, tools, { modelName: 'gpt-5.5' });
  const assistantMessage = compiled.input.find((item) => item.type === 'message' && item.role === 'assistant');

  assert(Boolean(assistantMessage), 'assistant text history should be preserved');
  assert(!('id' in assistantMessage), 'assistant text history should not invent an output item id');
  assert(!('status' in assistantMessage), 'assistant text history should not invent an output item status');
}

function testRetryAfterAcceptsSdkHeaderObjects(): void {
  const retryAfterMs = parseRetryAfter({ 'retry-after': '2' });

  assert(retryAfterMs === 2000, 'plain SDK header objects should parse retry-after');
  assert(parseRetryAfter({ 'Retry-After': '3' }) === 3000, 'header matching should be case-insensitive');
}

async function testFallbackToNonStreamingOnEmptyStream(): Promise<void> {
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

  assert(result.content === 'fallback ok', 'fallback response should be returned');
  assert(streamCalls === 1, 'stream path should be attempted once');
  assert(createCalls === 1, 'non-streaming fallback should be used once');
}

await testFallbackToNonStreamingOnEmptyStream();
testCompileSimpleConversation();
testCompileToolAndAssistantHistory();
testAssistantTextHistoryAvoidsGeneratedOutputIds();
testRetryAfterAcceptsSdkHeaderObjects();

console.log('OpenAI Responses compilation tests passed');
