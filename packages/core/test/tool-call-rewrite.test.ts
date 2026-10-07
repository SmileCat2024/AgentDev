/**
 * 工具调用历史改写端到端测试（ADR-0023 / PR-2）
 *
 * 经 Agent + 假 LLM 走完整 ReAct 循环，覆盖：
 * - 合法改写：第二次 LLM 请求看到生效调用；display.rewrittenCall 携带原始调用；
 *   会话事件流发射原始调用（事实先于改写）
 * - 三条校验失败路径：历史按原始调用写入，结果原样
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import { withRewrite } from '../src/core/tool-call-rewrite.js';
import { subscribeSessionEvents } from '../src/core/session-events.js';
import type { SessionEvent, ToolCallItem } from '../src/core/session-events.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

/**
 * 第一次调用返回指定 toolCalls，之后返回终态文本；
 * 每次 chat 记录收到的 messages 供断言。
 */
class ScriptedLLM implements LLMClient {
  readonly requests: Message[][] = [];

  constructor(private firstResponse: LLMResponse) {}

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.requests.push(messages.map(m => ({ ...m })));
    if (this.requests.length === 1) {
      return this.firstResponse;
    }
    return { content: 'done' };
  }
}

class RewriteTestAgent extends Agent {
  constructor(llm: LLMClient, tools: Tool[]) {
    super({ llm, maxTurns: 5, name: 'RewriteTestAgent', tools });
  }
}

const targetTool: Tool = {
  name: 'read_file',
  description: 'Read file',
  execute: async () => 'target-content',
};

describe('Tool call history rewrite（ADR-0023）', () => {
  it('合法改写：第二次 LLM 请求看到生效调用，display 与事件流各归其位', async () => {
    const llm = new ScriptedLLM({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'normalize', arguments: { path: './a.ts' } }],
    });
    const normalize: Tool = {
      name: 'normalize',
      description: 'Alias tool that normalizes path then executes read_file',
      rewritable: true,
      execute: async (args, ctx) => {
        const normalized = { path: `D:/abs/${(args.path as string).replace('./', '')}` };
        return withRewrite(
          JSON.stringify({ ok: true, path: normalized.path }),
          { id: ctx?.callId ?? 'missing', name: 'read_file', arguments: normalized },
        );
      },
    };
    const agent = new RewriteTestAgent(llm, [normalize, targetTool]);

    const events: SessionEvent[] = [];
    const unsubscribe = subscribeSessionEvents(e => events.push(e));

    try {
      await agent.onCall('go');
    } finally {
      unsubscribe();
    }

    // 第二次 LLM 请求：assistant 调用已是生效值，如同模型当时就是这么调的
    const secondRequest = llm.requests[1];
    const assistant = secondRequest.find(m => m.role === 'assistant')!;
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls![0]).toMatchObject({ id: 'tc_1', name: 'read_file' });
    expect(assistant.toolCalls![0].arguments).toEqual({ path: 'D:/abs/a.ts' });
    // tool 消息与生效调用按 id 配对，内容为工具返回文本
    const toolMessage = secondRequest.find(m => m.role === 'tool')!;
    expect(toolMessage.toolCallId).toBe('tc_1');
    expect(toolMessage.content).toContain('D:/abs/a.ts');

    // display 通道携带原始调用快照（前端"已修改"标注数据源，不注入 LLM）
    const storedTool = agent.getContext().getAll().find(m => m.role === 'tool')!;
    expect(storedTool.display).toMatchObject({
      rewrittenCall: { name: 'normalize', arguments: { path: './a.ts' } },
    });

    // 会话事件流发射的是原始调用（写入时刻、改写之前）
    const completed = events.find(
      e => e.type === 'item.completed' && e.item.type === 'tool_call',
    );
    const item = (completed as { item: ToolCallItem }).item;
    expect(item.tool).toBe('normalize');
    expect(item.arguments).toEqual({ path: './a.ts' });
  });

  it('失败路径：工具未声明 rewritable → 放弃改写，历史记原始调用', async () => {
    const llm = new ScriptedLLM({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'sneaky', arguments: {} }],
    });
    const sneaky: Tool = {
      name: 'sneaky',
      description: 'Not declared rewritable',
      execute: async (_args, ctx) =>
        withRewrite('ok', { id: ctx?.callId ?? 'missing', name: 'read_file', arguments: {} }),
    };
    const agent = new RewriteTestAgent(llm, [sneaky, targetTool]);
    await agent.onCall('go');

    const secondRequest = llm.requests[1];
    const assistant = secondRequest.find(m => m.role === 'assistant')!;
    expect(assistant.toolCalls![0].name).toBe('sneaky');
    const storedTool = agent.getContext().getAll().find(m => m.role === 'tool')!;
    expect(storedTool.display).toBeUndefined();
  });

  it('失败路径：effectiveCall.id 与原调用不一致 → 放弃改写', async () => {
    const llm = new ScriptedLLM({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'normalize', arguments: {} }],
    });
    const normalize: Tool = {
      name: 'normalize',
      description: 'Rewritable but declares a mismatched id',
      rewritable: true,
      execute: async () =>
        withRewrite('ok', { id: 'tc_bogus', name: 'read_file', arguments: {} }),
    };
    const agent = new RewriteTestAgent(llm, [normalize, targetTool]);
    await agent.onCall('go');

    const secondRequest = llm.requests[1];
    const assistant = secondRequest.find(m => m.role === 'assistant')!;
    expect(assistant.toolCalls![0].name).toBe('normalize');
    expect(assistant.toolCalls![0].id).toBe('tc_1');
  });

  it('失败路径：改写目标工具未注册 → 放弃改写', async () => {
    const llm = new ScriptedLLM({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'normalize', arguments: {} }],
    });
    const normalize: Tool = {
      name: 'normalize',
      description: 'Rewritable but targets an unregistered tool',
      rewritable: true,
      execute: async (_args, ctx) =>
        withRewrite('ok', { id: ctx?.callId ?? 'missing', name: 'ghost_tool', arguments: {} }),
    };
    const agent = new RewriteTestAgent(llm, [normalize, targetTool]);
    await agent.onCall('go');

    const secondRequest = llm.requests[1];
    const assistant = secondRequest.find(m => m.role === 'assistant')!;
    expect(assistant.toolCalls![0].name).toBe('normalize');
    // 结果原样返回，不中断本轮
    const toolMessage = secondRequest.find(m => m.role === 'tool')!;
    expect(toolMessage.content).toContain('ok');
  });

  it('参数自修正场景：同名工具只改参数', async () => {
    const llm = new ScriptedLLM({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: { path: './a.ts' } }],
    });
    const readWithNormalize: Tool = {
      name: 'read_file',
      description: 'Read file, normalizing relative paths',
      rewritable: true,
      execute: async (args, ctx) => {
        const normalized = { path: `D:/abs/${(args.path as string).replace('./', '')}` };
        return withRewrite(
          JSON.stringify({ ok: true, path: normalized.path }),
          { id: ctx?.callId ?? 'missing', name: 'read_file', arguments: normalized },
        );
      },
    };
    const agent = new RewriteTestAgent(llm, [readWithNormalize]);
    await agent.onCall('go');

    const secondRequest = llm.requests[1];
    const assistant = secondRequest.find(m => m.role === 'assistant')!;
    expect(assistant.toolCalls![0].name).toBe('read_file');
    expect(assistant.toolCalls![0].arguments).toEqual({ path: 'D:/abs/a.ts' });
    expect(assistant.toolCalls![0].id).toBe('tc_1');

    const storedTool = agent.getContext().getAll().find(m => m.role === 'tool')!;
    expect(storedTool.display).toMatchObject({
      rewrittenCall: { name: 'read_file', arguments: { path: './a.ts' } },
    });
  });
});
