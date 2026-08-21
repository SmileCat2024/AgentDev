import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { compileContextForAnthropic } from '../llm/anthropic.js';
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

describe('Anthropic context compilation', () => {
  it('should compile prefix system messages to top-level system array', () => {
    const messages: Message[] = [
      { role: 'system', content: '你是 ReAct agent。' },
      { role: 'system', content: '必须使用工具。' },
      { role: 'user', content: '上海天气如何？' },
    ];

    const compiled = compileContextForAnthropic(messages, tools);

    expect(Array.isArray(compiled.system)).toBe(true);
    expect(compiled.system).toHaveLength(2);
    expect(compiled.system?.[0]?.type).toBe('text');
    expect(compiled.messages).toHaveLength(1);
    expect(compiled.messages[0]?.role).toBe('user');
  });

  it('should lower reminder and tool result into synthesized user turn', () => {
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

    expect(compiled.messages).toHaveLength(3);
    expect(lastMessage?.role).toBe('user');
    expect(Array.isArray(lastMessage?.content)).toBe(true);

    const contentBlocks = lastMessage?.content as Array<Record<string, unknown>>;
    expect(contentBlocks[0]?.type).toBe('tool_result');
    expect(contentBlocks[1]?.type).toBe('text');
    expect(String(contentBlocks[1]?.text || '')).toContain('<reminder>');
  });

  it('should merge reminder before explicit user into that user turn', () => {
    const messages: Message[] = [
      { role: 'system', content: '固定 system' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'system', content: '第二轮必须用中文。' },
      { role: 'user', content: '第二问' },
    ];

    const compiled = compileContextForAnthropic(messages, []);
    const secondUser = compiled.messages[2];

    expect(secondUser?.role).toBe('user');
    expect(Array.isArray(secondUser?.content)).toBe(true);

    const contentBlocks = secondUser?.content as Array<Record<string, unknown>>;
    expect(contentBlocks).toHaveLength(2);
    expect(String(contentBlocks[0]?.text || '')).toContain('<reminder>第二轮必须用中文。</reminder>');
    expect(contentBlocks[1]?.text).toBe('第二问');
  });

  it('should compile tool_use with empty content', () => {
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
    expect(assistantTurn?.role).toBe('assistant');
    expect(Array.isArray(assistantTurn?.content)).toBe(true);
  });

  it('should replay thinking blocks into assistant history', () => {
    const messages: Message[] = [
      { role: 'system', content: '固定 system' },
      { role: 'user', content: '请继续分析' },
      {
        role: 'assistant',
        content: '先看最近结果。',
        thinkingBlocks: [
          {
            signature: 'sig_1',
            thinking: '需要延续上一轮的思路。',
          },
        ],
      },
    ];

    const compiled = compileContextForAnthropic(messages, []);
    const assistantTurn = compiled.messages[1];

    expect(assistantTurn?.role).toBe('assistant');
    expect(Array.isArray(assistantTurn?.content)).toBe(true);

    const contentBlocks = assistantTurn?.content as Array<Record<string, unknown>>;
    expect(contentBlocks[0]?.type).toBe('thinking');
    expect(contentBlocks[0]?.signature).toBe('sig_1');
    expect(contentBlocks[0]?.thinking).toBe('需要延续上一轮的思路。');
    expect(contentBlocks[1]?.type).toBe('text');
  });

  it('should route sourced system messages before first user to reminder, not top-level system', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Agent system prompt' },
      { role: 'system', content: 'Handoff summary content', source: 'handoff-seed' },
      { role: 'user', content: 'Continue the work' },
    ];

    const compiled = compileContextForAnthropic(messages, []);

    // Only the agent system prompt (no source) goes to top-level system
    expect(compiled.system).toHaveLength(1);
    expect(String((compiled.system?.[0] as any)?.text || '')).toBe('Agent system prompt');

    // The sourced system message becomes a <reminder> block embedded in the user turn
    expect(compiled.messages).toHaveLength(1);
    expect(compiled.messages[0]?.role).toBe('user');
    const contentBlocks = compiled.messages[0]?.content as Array<Record<string, unknown>>;
    expect(contentBlocks).toHaveLength(2);
    expect(String(contentBlocks[0]?.text || '')).toContain('<reminder>');
    expect(String(contentBlocks[0]?.text || '')).toContain('Handoff summary content');
    expect(contentBlocks[1]?.text).toBe('Continue the work');
  });

  it('should route multiple sourced system messages as separate reminder blocks', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Agent prompt' },
      { role: 'system', content: 'Summary', source: 'handoff-seed' },
      { role: 'system', content: 'Important file: foo.ts', source: 'handoff-seed' },
      { role: 'user', content: 'Start' },
    ];

    const compiled = compileContextForAnthropic(messages, []);

    expect(compiled.system).toHaveLength(1);
    const contentBlocks = compiled.messages[0]?.content as Array<Record<string, unknown>>;
    // Two reminder blocks + one user text block
    expect(contentBlocks).toHaveLength(3);
    expect(String(contentBlocks[0]?.text || '')).toContain('<reminder>Summary</reminder>');
    expect(String(contentBlocks[1]?.text || '')).toContain('<reminder>Important file: foo.ts</reminder>');
    expect(contentBlocks[2]?.text).toBe('Start');
  });
});
