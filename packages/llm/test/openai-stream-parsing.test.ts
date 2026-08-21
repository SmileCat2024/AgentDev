import { describe, it, expect } from 'vitest';
import { OpenAILLM } from '../src/openai.js';

/**
 * 复现 OpenAI 兼容网关（OpenCode Go / deepseek 等）流式行为下增量丢失的缺陷：
 * 1. 同一 delta 同时携带 reasoning_content 尾巴与 content 开头 → content 开头被丢弃
 * 2. tool_call 增量省略 index 字段 → 整个工具调用被静默丢弃（会话"没有工具就被打断"）
 * 3. finish_reason chunk 之后仍跟随增量 chunk → 尾部增量丢失
 */

function makeChunk(fields: Record<string, unknown>) {
  return { id: 'x', object: 'chat.completion.chunk', ...fields };
}

function mockStream(llm: OpenAILLM, chunks: unknown[]) {
  (llm as any).client.chat.completions.create = async () => ({
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  });
}

function makeLLM() {
  return new OpenAILLM('test-key', 'deepseek-v4-flash', 'https://mock.local/v1');
}

describe('OpenAI streaming delta robustness', () => {
  it('keeps content when a transition delta carries reasoning_content and content together', async () => {
    const llm = makeLLM();
    mockStream(llm, [
      makeChunk({ choices: [{ index: 0, delta: { reasoning_content: 'thinking...' }, finish_reason: null }] }),
      // 过渡 chunk：reasoning 尾巴 + 正文开头同包
      makeChunk({ choices: [{ index: 0, delta: { reasoning_content: ' done', content: 'The d' }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: { content: 'irectory has 85 files.' }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ]);

    const result = await llm.chat([{ role: 'user', content: 'hi' }], []);

    expect(result.content).toBe('The directory has 85 files.');
    expect(result.reasoning).toBe('thinking... done');
  });

  it('accumulates tool calls that omit the index field', async () => {
    const llm = makeLLM();
    mockStream(llm, [
      makeChunk({ choices: [{ index: 0, delta: { reasoning_content: 'need ls' }, finish_reason: null }] }),
      // 网关省略 index：首增量带 id+name，后续增量仅 arguments 片段
      makeChunk({ choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_1', function: { name: 'ls', arguments: '{"dirPa' } }] }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: 'th":"/tmp"}' } }] }, finish_reason: null }] }),
      makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ]);

    const result = await llm.chat([{ role: 'user', content: 'list dir' }], []);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe('call_1');
    expect(result.toolCalls![0].name).toBe('ls');
    expect(result.toolCalls![0].arguments).toEqual({ dirPath: '/tmp' });
  });

  it('collects trailing deltas that arrive after the finish_reason chunk', async () => {
    const llm = makeLLM();
    mockStream(llm, [
      makeChunk({ choices: [{ index: 0, delta: { content: 'Reading files.' }, finish_reason: null }] }),
      // 部分网关 finish_reason 先行、增量殿后
      makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      makeChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read', arguments: '{"filePath":"/tmp/a"}' } }] }, finish_reason: null }] }),
      makeChunk({ usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }, choices: [] }),
    ]);

    const result = await llm.chat([{ role: 'user', content: 'read' }], []);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('read');
    expect(result.usage?.totalTokens).toBe(7);
  });
});
