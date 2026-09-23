import { describe, it, expect } from 'vitest';
import { compileContextForAnthropic } from '../src/anthropic.js';
import { compileChatMessages } from '../src/openai.js';
import { compileContextForOpenAIResponses } from '../src/openai-responses.js';
import type { Message } from '@agentdevjs/core';

/**
 * 尾部 reminder：reminder 唤醒的 call 里，触发消息（带 source 的 system）
 * 是 context 的最后一条，其后没有 user 消息。三个编译器必须把它物化为
 * 线上的 user 输入，否则模型收不到唤醒内容。
 */
const trailingReminderContext: Message[] = [
  { role: 'user', content: '跑一下测试' },
  { role: 'assistant', content: '好的，启动后台任务。' },
  { role: 'system', content: '[后台任务 bg-1 已完成]\n退出码: 0', source: 'shell' },
];

describe('trailing reminder compiles to a wire-level user turn', () => {
  it('anthropic: materializes as the final user message containing a <reminder> block', () => {
    const compiled = compileContextForAnthropic(trailingReminderContext, []);
    const messages = compiled.messages;

    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    const text = JSON.stringify(last.content ?? '');
    expect(text).toContain('<reminder>');
    expect(text).toContain('[后台任务 bg-1 已完成]');
    // 不混入顶层 system
    expect(JSON.stringify(compiled.system ?? [])).not.toContain('[后台任务 bg-1 已完成]');
  });

  it('openai chat: materializes as the final user message with wrapped reminder text', () => {
    const compiled = compileChatMessages(trailingReminderContext);

    const last = compiled[compiled.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('<reminder>');
    expect(String(last.content)).toContain('[后台任务 bg-1 已完成]');
  });

  it('openai responses (codex): replays mid-conversation system as user input', () => {
    const request = compileContextForOpenAIResponses(trailingReminderContext, [], { responsesProfile: 'codex' });

    const messageItems = request.input.filter((item: any) => item.type === 'message') as any[];
    const last = messageItems[messageItems.length - 1];
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('[后台任务 bg-1 已完成]');
  });
});
