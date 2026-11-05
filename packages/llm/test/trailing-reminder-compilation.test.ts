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

/**
 * 接续后的第二轮调用：handoff seed（带 source 的 system）之后，新会话已经
 * 跑了一轮工具调用，恢复指令再作为 system 追加。此时首条非 system 消息是
 * assistant —— Anthropic 要求首条必须是 user，编译器须把攒下的 reminder
 * 物化成 user turn，而不是抛错。
 */
const seededSessionSecondTurn: Message[] = [
  { role: 'system', content: '## 系统设定\n你是自动化编码智能体', },
  { role: 'system', content: '# AGENT.md 内容', source: 'memory' },
  { role: 'system', content: '以下是前一会话的工作摘要……', source: 'handoff-seed' },
  { role: 'system', content: '上下文已精简接续。继续工作前请先审视任务状态。', source: 'thread' },
  { role: 'assistant', content: '继续读取第 3 个文件', toolCalls: [{ id: 'call_1', name: 'read', arguments: { filePath: 'a.js' } }] },
  { role: 'tool', content: '{"content":"file body"}', toolCallId: 'call_1' },
];

describe('seeded handoff session keeps compiling after the successor acts', () => {
  it('anthropic: leading reminders become the first user turn instead of throwing', () => {
    const compiled = compileContextForAnthropic(seededSessionSecondTurn, []);
    const roles = compiled.messages.map((m: any) => m.role);

    expect(roles[0]).toBe('user');
    expect(roles).toContain('assistant');
    // 三条带 source 的 reminder 都进入首个 user turn
    const firstText = JSON.stringify(compiled.messages[0].content);
    expect(firstText).toContain('<reminder>');
    expect(firstText).toContain('前一会话的工作摘要');
    expect(firstText).toContain('上下文已精简接续');
    // 无 source 的系统提示仍走顶层 system，不混进 user turn
    expect(JSON.stringify(compiled.system ?? [])).toContain('你是自动化编码智能体');
    expect(firstText).not.toContain('你是自动化编码智能体');
  });

  it('anthropic: assistant without any leading reminder still fails loudly', () => {
    // 无 reminder 可物化时，缺失 user 起点仍是调用方错误，不静默吞掉
    expect(() => compileContextForAnthropic([
      { role: 'system', content: 'only agent prompt' },
      { role: 'assistant', content: '凭空发言' },
    ], [])).toThrow(/first non-system message to be user/);
  });

  it('openai chat: seeded session compiles without a user-leading constraint', () => {
    const compiled = compileChatMessages(seededSessionSecondTurn);
    expect(compiled.length).toBeGreaterThan(0);
    expect(compiled.some((m: any) => m.role === 'assistant')).toBe(true);
  });
});
