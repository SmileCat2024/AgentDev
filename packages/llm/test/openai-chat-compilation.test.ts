import { describe, it, expect } from 'vitest';
import { compileChatMessages } from '../src/openai.js';
import type { Message } from '@agentdevjs/core';

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

  it('should merge multiple no-source system messages into a single leading system message', () => {
    // 真实场景：agent 系统提示词 + MemoryFeature 经 context.add 注入的 CLAUDE.md。
    // vLLM Qwen chat template 等严格后端只接受一条位于开头的 system。
    const messages: Message[] = [
      { role: 'system', content: '## 系统设定' },
      { role: 'system', content: '# CLAUDE.md' },
      { role: 'user', content: '你好' },
    ];

    const compiled = compileChatMessages(messages);

    expect(compiled).toHaveLength(2);
    expect(compiled[0]).toEqual({ role: 'system', content: '## 系统设定\n\n# CLAUDE.md' });
    expect(compiled[1]).toEqual({ role: 'user', content: '你好' });
    // 不变量：整个消息数组中恰好一条 system 且位于开头
    expect(compiled.filter(m => m.role === 'system')).toHaveLength(1);
  });

  it('should wrap sourced system messages as reminder prefixed to the next user turn', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'system', content: 'handoff 摘要', source: 'handoff-seed' },
      { role: 'user', content: '继续' },
    ];

    const compiled = compileChatMessages(messages);

    expect(compiled).toHaveLength(2);
    expect(compiled[0]).toEqual({ role: 'system', content: 'sys' });
    expect(compiled[1]).toEqual({
      role: 'user',
      content: '<reminder>handoff 摘要</reminder>\n\n继续',
    });
  });

  it('should flush trailing sourced system message as a standalone user message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: '续接上下文', source: 'partial-compact' },
    ];

    const compiled = compileChatMessages(messages);

    expect(compiled).toHaveLength(4);
    expect(compiled[3]).toEqual({ role: 'user', content: '<reminder>续接上下文</reminder>' });
  });

  it('should treat no-source system after first user as reminder, not merging into leading system', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'mid system' },
      { role: 'user', content: 'again' },
    ];

    const compiled = compileChatMessages(messages);

    expect(compiled).toHaveLength(3);
    expect(compiled[0]).toEqual({ role: 'system', content: 'sys' });
    expect(compiled[1]).toEqual({ role: 'user', content: 'hi' });
    expect(compiled[2]).toEqual({ role: 'user', content: '<reminder>mid system</reminder>\n\nagain' });
  });

  it('should keep assistant tool_calls paired with tool messages when reminders are pending', () => {
    // reminder 不得插入 assistant(tool_calls) 与 tool 之间，否则严格后端
    // 会因配对断裂返回 400
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '列目录' },
      { role: 'system', content: '注入提醒', source: 'some-feature' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'ls', arguments: {} }],
      },
      { role: 'tool', content: '{}', toolCallId: 'call_1' },
      { role: 'user', content: '继续' },
    ];

    const compiled = compileChatMessages(messages);

    const assistantIndex = compiled.findIndex(m => m.role === 'assistant');
    const toolIndex = compiled.findIndex(m => m.role === 'tool');
    expect(toolIndex).toBe(assistantIndex + 1);

    // reminder 最终拼进下一个 user turn，而非插在配对之间
    const finalUser = compiled[compiled.length - 1] as { role: string; content: string };
    expect(finalUser.content).toContain('<reminder>注入提醒</reminder>');
    expect(finalUser.content).toContain('继续');
  });

  it('should not double-wrap content that already starts with reminder tag', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'system', content: '<reminder>已包装</reminder>', source: 'x' },
      { role: 'user', content: 'hi' },
    ];

    const compiled = compileChatMessages(messages);

    expect((compiled[1] as { content: string }).content).toBe(
      '<reminder>已包装</reminder>\n\nhi',
    );
  });
});
