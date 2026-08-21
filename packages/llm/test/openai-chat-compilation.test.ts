import { describe, it, expect } from 'vitest';
import { compileChatMessages } from '../src/openai.js';
import type { Message } from '@agentdev/core';

describe('OpenAI Chat Completions compilation', () => {
  it('should pass through plain messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];

    const compiled = compileChatMessages(messages);

    expect(compiled).toHaveLength(3);
    expect(compiled[0]).toEqual({ role: 'system', content: 'sys' });
    expect(compiled[2]).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('should serialize assistant toolCalls to tool_calls and keep tool messages paired', () => {
    const messages: Message[] = [
      { role: 'user', content: '列出目录' },
      {
        role: 'assistant',
        content: '我先查看目录结构。',
        toolCalls: [{ id: 'call_00_abc', name: 'ls', arguments: { dirPath: '/tmp' } }],
      },
      { role: 'tool', content: '{"success":true}', toolCallId: 'call_00_abc' },
    ];

    const compiled = compileChatMessages(messages);

    const assistantMsg = compiled.find(m => m.role === 'assistant') as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistantMsg.tool_calls).toBeDefined();
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls![0].id).toBe('call_00_abc');
    expect(assistantMsg.tool_calls![0].function.name).toBe('ls');
    // wire 格式要求 arguments 是 JSON 字符串（内部存储为对象）
    expect(assistantMsg.tool_calls![0].function.arguments).toBe('{"dirPath":"/tmp"}');

    const toolMsg = compiled.find(m => m.role === 'tool') as OpenAI.Chat.ChatCompletionToolMessageParam;
    expect(toolMsg.tool_call_id).toBe('call_00_abc');

    // 配对不变量：tool 消息前必须存在携带该 id 的 assistant tool_calls（严格后端校验项）
    const toolIndex = compiled.findIndex(m => m.role === 'tool');
    const hasMatchingCall = compiled
      .slice(0, toolIndex)
      .some(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === 'call_00_abc'));
    expect(hasMatchingCall).toBe(true);
  });

  it('should serialize multiple toolCalls and default empty arguments to {}', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: null as unknown as string,
        toolCalls: [
          { id: 'c1', name: 'a', arguments: {} },
          { id: 'c2', name: 'b', arguments: { x: 1 } },
        ],
      },
    ];

    const compiled = compileChatMessages(messages);
    const assistantMsg = compiled[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam;

    expect(assistantMsg.content).toBe('');
    expect(assistantMsg.tool_calls![0].function.arguments).toBe('{}');
    expect(assistantMsg.tool_calls![1].function.arguments).toBe('{"x":1}');
  });

  it('should not add tool_calls to assistant messages without toolCalls', () => {
    const messages: Message[] = [{ role: 'assistant', content: '纯文本回复' }];

    const compiled = compileChatMessages(messages);

    expect(compiled[0]).toEqual({ role: 'assistant', content: '纯文本回复' });
    expect('tool_calls' in compiled[0]).toBe(false);
  });

  it('should degrade user images to text placeholders in non-vision mode', () => {
    const messages: Message[] = [
      { role: 'user', content: '看图', images: [{ source: 'img1.png' } as never] },
    ];

    const compiled = compileChatMessages(messages, false);

    expect(compiled).toHaveLength(1);
    expect((compiled[0] as { content: string }).content).toContain('看图');
    expect((compiled[0] as { content: string }).content).toContain('【Image】img1.png');
  });
});
