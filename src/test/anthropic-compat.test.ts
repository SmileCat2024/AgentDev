import { compileContextForAnthropic } from '../llm/anthropic.js';
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

function testPrefixSystemCompilesToTopLevelSystem(): void {
  const messages: Message[] = [
    { role: 'system', content: '你是 ReAct agent。' },
    { role: 'system', content: '必须使用工具。' },
    { role: 'user', content: '上海天气如何？' },
  ];

  const compiled = compileContextForAnthropic(messages, tools);

  assert(Array.isArray(compiled.system), 'prefix system should compile to top-level anthropic system array');
  assert(compiled.system?.length === 2, 'all prefix system messages should be preserved as separate blocks');
  assert(compiled.system?.[0]?.type === 'text', 'system blocks should remain text blocks');
  assert(compiled.messages.length === 1, 'user message should remain in conversation messages');
  assert(compiled.messages[0]?.role === 'user', 'first conversation message should be user');
}

function testReminderAndToolResultAreLoweredIntoUserTurn(): void {
  const messages: Message[] = [
    { role: 'system', content: '固定 system' },
    { role: 'user', content: '帮我查上海天气' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tool_1', name: 'weather', arguments: { city: 'Shanghai' } }],
    },
    {
      role: 'tool',
      toolCallId: 'tool_1',
      content: JSON.stringify({ success: true, result: '18°C 晴天' }),
    },
    { role: 'system', content: '现在只需要总结天气，不要展开。' },
  ];

  const compiled = compileContextForAnthropic(messages, tools);
  const lastMessage = compiled.messages[compiled.messages.length - 1];

  assert(compiled.messages.length === 3, 'assistant tool call should be followed by a synthesized user turn');
  assert(lastMessage?.role === 'user', 'tool result and reminder should compile into a user turn');
  assert(Array.isArray(lastMessage?.content), 'synthesized user turn should use content blocks');

  const contentBlocks = lastMessage?.content as Array<Record<string, unknown>>;
  assert(contentBlocks[0]?.type === 'tool_result', 'tool result should stay in the synthesized user turn');
  assert(contentBlocks[1]?.type === 'text', 'dynamic reminder should be compiled into a text block');
  assert(String(contentBlocks[1]?.text || '').includes('<reminder>'), 'dynamic reminder should be wrapped with reminder XML');
}

function testReminderBeforeExplicitUserGetsMergedIntoThatUser(): void {
  const messages: Message[] = [
    { role: 'system', content: '固定 system' },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'system', content: '第二轮必须用中文。' },
    { role: 'user', content: '第二问' },
  ];

  const compiled = compileContextForAnthropic(messages, []);
  const secondUser = compiled.messages[2];

  assert(secondUser?.role === 'user', 'second user turn should stay user');
  assert(Array.isArray(secondUser?.content), 'reminder should merge into the explicit user turn as content blocks');

  const contentBlocks = secondUser?.content as Array<Record<string, unknown>>;
  assert(contentBlocks.length === 2, 'merged user turn should contain reminder and user text');
  assert(String(contentBlocks[0]?.text || '').includes('<reminder>第二轮必须用中文。</reminder>'), 'reminder should appear before user text');
  assert(contentBlocks[1]?.text === '第二问', 'original user text should be preserved');
}

testPrefixSystemCompilesToTopLevelSystem();
testReminderAndToolResultAreLoweredIntoUserTurn();
testReminderBeforeExplicitUserGetsMergedIntoThatUser();

function testToolUseWithEmptyStartInputStillCompiles(): void {
  const assistantMessage: Message = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'tool_1', name: 'run_command', arguments: { command: 'echo "rm"' } }],
  };

  const compiled = compileContextForAnthropic([
    { role: 'system', content: '固定 system' },
    { role: 'user', content: '执行 echo "rm"' },
    assistantMessage,
  ], [
    {
      name: 'run_command',
      description: 'Run command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      async execute() {
        return {};
      },
    },
  ]);

  const assistantTurn = compiled.messages[1];
  assert(assistantTurn?.role === 'assistant', 'assistant tool call turn should be preserved');
  assert(Array.isArray(assistantTurn?.content), 'assistant tool call turn should compile to blocks');
}

testToolUseWithEmptyStartInputStillCompiles();

console.log('Anthropic compatibility tests passed');
