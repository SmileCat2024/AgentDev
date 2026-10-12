/**
 * 空消息启动（kind: 'resume'）语义测试
 *
 * 覆盖：
 * - 不追加消息：resume 回合不新增 user/system 消息，凭既有上下文续跑
 * - 悬空补齐：尾部 assistant 的 toolCalls 缺结果时按中断结果补齐（ADR-0005）
 * - 正常尾部：无悬空时不补任何消息
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import { Context } from '../src/core/context.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

/** 记录每次收到的消息（验证协议完整性与"不追加"） */
class SpyLLM implements LLMClient {
  calls: Message[][] = [];

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.calls.push(messages.map(m => ({ ...m })));
    return { content: 'done' };
  }
}

describe('空消息启动（kind: resume）', () => {
  it('不追加任何消息：LLM 收到的消息与 resume 前上下文一致', async () => {
    const llm = new SpyLLM();
    const agent = new Agent({ llm, maxTurns: 1 });
    await agent.onCallDetailed('first turn');
    llm.calls.length = 0;

    const contextBefore = agent.getContext().getAll().slice();
    await agent.onCallDetailed('', [], [], undefined, { kind: 'resume' });

    // resume 回合 LLM 第一次调用收到的消息 = resume 前全部消息（无新增 user/system）
    expect(llm.calls[0].length).toBe(contextBefore.length);
    expect(llm.calls[0].map(m => m.role)).toEqual(contextBefore.map(m => m.role));
  });

  it('悬空补齐：尾部 toolCalls 缺结果时按中断结果补齐后发起请求', async () => {
    const llm = new SpyLLM();
    const agent = new Agent({ llm, maxTurns: 1 });
    // 手工构造崩溃现场：assistant 发起工具调用，无工具结果
    const context = new Context();
    context.addUserMessage('run tool', 0);
    context.addAssistantMessage(
      { content: 'Calling.', toolCalls: [{ id: 'tc_1', name: 'echo', arguments: {} }] } as LLMResponse,
      0,
    );
    (agent as any).persistentContext = context;

    await agent.onCallDetailed('', [], [], undefined, { kind: 'resume' });

    // 补齐的 tool 消息出现在 LLM 请求里：tc_1 有对应结果
    const padded = llm.calls[0].filter(m => m.role === 'tool' && m.toolCallId === 'tc_1');
    expect(padded.length).toBe(1);
  });

  it('正常尾部：assistant 文本收尾时 resume 不补任何消息', async () => {
    const llm = new SpyLLM();
    const agent = new Agent({ llm, maxTurns: 2 });
    await agent.onCallDetailed('first turn'); // ImmediateLLM 文本收尾，无 toolCalls
    llm.calls.length = 0;

    await agent.onCallDetailed('', [], [], undefined, { kind: 'resume' });

    const first = llm.calls[0];
    expect(first.some(m => m.role === 'tool')).toBe(false);
    // 仅首轮的 user 消息，resume 未追加新输入
    expect(first.filter(m => m.role === 'user').length).toBe(1);
  });
});
