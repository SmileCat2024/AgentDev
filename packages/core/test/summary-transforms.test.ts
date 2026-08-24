/**
 * Summary 官方变换测试（ticket 006）。
 *
 * 覆盖：提示词构建、<analysis>/<summary> 剥离、重要文件/技能扫描，
 * 以及 Summary / Trim-Transcript-with-Summary 两个变换实现（用 mock LLM）。
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { AgentSessionSnapshot } from '../src/core/session-store.js';
import {
  buildSummaryPrompt,
  stripCompactAnalysis,
  scanFilesAndSkills,
  buildSummarySeedMessage,
  generateSummaryText,
  SummaryTransformation,
  TrimTranscriptWithSummaryTransformation,
} from '../src/core/continuity/transforms/index.js';
import type { TransformContext } from '../src/core/continuity/index.js';

function makeSnapshot(messages: any[]): AgentSessionSnapshot {
  return {
    version: 1,
    sessionId: 's1',
    savedAt: 0,
    agentType: 'test',
    runtime: {
      initialized: true,
      callIndex: 0,
      context: { messages } as any,
      featureStates: [],
    },
    rollbackHistory: [],
  } as any;
}

function makeLLM(summaryText: string): TransformContext['llm'] {
  return {
    async chat() {
      return { content: summaryText, stopReason: 'end_turn' } as any;
    },
  } as any;
}

describe('buildSummaryPrompt', () => {
  it('returns base prompt by default', () => {
    const prompt = buildSummaryPrompt({});
    assert.ok(prompt.includes('你的任务是为当前对话创建一份详细摘要'));
    assert.ok(!prompt.includes('额外压缩指令'));
  });

  it('appends additional instructions', () => {
    const prompt = buildSummaryPrompt({ additionalInstructions: 'focus on tests' });
    assert.ok(prompt.includes('额外压缩指令\nfocus on tests'));
  });

  it('uses trim-appended variant when requested', () => {
    const prompt = buildSummaryPrompt({ trimAppended: true });
    assert.ok(prompt.includes('工具调用记录中的参数细节和返回内容可能不会继续保留'));
  });
});

describe('stripCompactAnalysis', () => {
  it('strips analysis and summary wrappers', () => {
    const raw = '<analysis>thinking...</analysis>\n<summary>final summary</summary>';
    assert.equal(stripCompactAnalysis(raw), 'final summary');
  });

  it('returns body when no summary wrapper', () => {
    assert.equal(stripCompactAnalysis('plain text'), 'plain text');
  });

  it('returns empty for empty input', () => {
    assert.equal(stripCompactAnalysis(''), '');
  });
});

describe('scanFilesAndSkills', () => {
  it('collects important files, skills and ranges from assistant tool calls', () => {
    const messages = [
      { role: 'assistant', toolCalls: [
        { name: 'read', arguments: { filePath: 'a.ts', offset: 10, limit: 20 } },
        { name: 'write', arguments: { filePath: 'b.ts' } },
        { name: 'invoke_skill', arguments: { skill: 'xlsx' } },
        { name: 'grep', arguments: { pattern: 'x' } },
      ] },
      { role: 'user', content: 'hello' },
    ];
    const result = scanFilesAndSkills(messages);
    assert.deepEqual(result.files.sort(), ['a.ts', 'b.ts']);
    assert.deepEqual(result.skills, ['xlsx']);
    assert.deepEqual(result.fileRanges, { 'a.ts': '10-29' });
  });
});

describe('buildSummarySeedMessage', () => {
  it('wraps summary text in a system seed message', () => {
    const msg = buildSummarySeedMessage('summary body');
    assert.equal(msg.role, 'system');
    assert.ok(msg.content.includes('summary body'));
    assert.equal(msg.turn, 0);
  });
});

describe('generateSummaryText message construction', () => {
  function captureLLM(): { llm: TransformContext['llm']; captured: { messages: any[]; tools: any[]; options?: any } } {
    const captured: { messages: any[]; tools: any[]; options?: any } = { messages: [], tools: [] };
    const llm = {
      async chat(messages: any[], tools: any[], options?: any) {
        captured.messages = messages;
        captured.tools = tools;
        captured.options = options;
        return { content: 'summary text', stopReason: 'end_turn' } as any;
      },
    } as any;
    return { llm, captured };
  }

  it('replaces head static system prefix with role preamble + prompt, keeps mid-conversation systems, ends with user anchor', async () => {
    const { llm, captured } = captureLLM();
    const snapshot = makeSnapshot([
      { role: 'system', content: '你是某工作空间的执行 agent，负责自主交付' },
      { role: 'system', content: '# CLAUDE.md\n项目引导文档...' },
      { role: 'user', content: '开始任务', turn: 0 },
      { role: 'system', tag: 'folded-tool-activity', content: '[Folded tool activity] read(a.ts)', turn: 0 },
      { role: 'assistant', content: '完成', turn: 0 },
    ]);
    await generateSummaryText({ llm }, snapshot, buildSummaryPrompt({ trimAppended: true }));
    const { messages, tools } = captured;

    // 唯一的头部 system：身份澄清前缀 + 摘要提示词
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.includes('不是你与任何人的真实交互'));
    assert.ok(messages[0].content.includes('你的任务是为当前对话创建一份详细摘要'));
    // 头部静态 system（身份设定 / CLAUDE.md）被剥离
    const leaked = messages.filter((m) => m.content?.includes('执行 agent') || m.content?.includes('CLAUDE.md'));
    assert.equal(leaked.length, 0);
    // 对话主体保留，中途动态 system（folded-tool-activity）保留
    assert.ok(messages.some((m) => m.content === '开始任务'));
    assert.ok(messages.some((m) => m.tag === 'folded-tool-activity'));
    // 末尾 user 锚定
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'user');
    assert.ok(last.content.includes('会话记录到此为止'));
    // 空工具集
    assert.deepEqual(tools, []);
  });

  it('forwards the transform cancellation signal to the non-streaming LLM call', async () => {
    const { llm, captured } = captureLLM();
    const signal = new AbortController().signal;
    const snapshot = makeSnapshot([{ role: 'user', content: '继续', turn: 0 }]);
    await generateSummaryText({ llm, signal }, snapshot, buildSummaryPrompt({}));
    assert.equal(captured.options?.noStream, true);
    assert.equal(captured.options?.signal, signal);
  });

  it('injects tool results as tagged system messages with call signatures and truncation', async () => {
    const { llm, captured } = captureLLM();
    const longOutput = 'x'.repeat(3000);
    const snapshot = makeSnapshot([
      { role: 'user', content: '开始', turn: 0 },
      {
        role: 'assistant',
        content: '',
        turn: 0,
        toolCalls: [
          { id: 'tc1', name: 'read', arguments: { filePath: 'src/a.ts' } },
          { id: 'tc2', name: 'bash', arguments: { command: 'npm test' } },
        ],
      },
      { role: 'tool', toolCallId: 'tc1', content: 'file body line 1\nline 2', turn: 0 },
      { role: 'tool', toolCallId: 'tc2', content: longOutput, turn: 0 },
      { role: 'tool', toolCallId: 'tc-unknown', content: 'orphan result', turn: 0 },
    ]);
    await generateSummaryText({ llm }, snapshot, buildSummaryPrompt({ trimAppended: true }));
    const { messages } = captured;

    const toolResults = messages.filter((m) => m.tag === 'tool-result');
    assert.equal(toolResults.length, 3);
    assert.ok(toolResults[0].content.startsWith('[工具返回 read(a.ts)]\nfile body line 1'));
    // 长返回截断到上限并标注原始长度
    assert.ok(toolResults[1].content.includes('[工具返回 bash]'));
    assert.ok(toolResults[1].content.includes('…(返回已截断，原始长度 3000 字符)'));
    assert.ok(toolResults[1].content.length < 1400);
    // 配对失败仍保留内容，标注未匹配
    assert.ok(toolResults[2].content.includes('[工具返回 未匹配调用]'));
    assert.ok(toolResults[2].content.includes('orphan result'));
    // 全部以 system 注入（不冒充用户发言）
    assert.ok(toolResults.every((m) => m.role === 'system'));
  });
});

describe('SummaryTransformation', () => {
  it('produces a summary seed via llm context', async () => {
    const t = new SummaryTransformation();
    const snapshot = makeSnapshot([
      { role: 'user', content: 'build feature' },
      { role: 'assistant', content: 'ok', toolCalls: [{ name: 'read', arguments: { filePath: 'a.ts' } }] },
    ]);
    const seed = await t.transform({ sourceSnapshot: snapshot }, { llm: makeLLM('summary of work') });

    assert.equal(seed.schemaVersion, 1);
    assert.equal(seed.seedMessages.length, 1);
    assert.equal(seed.seedMessages[0].role, 'system');
    assert.ok(seed.seedMessages[0].content.includes('summary of work'));
    assert.deepEqual(seed.importantFiles, ['a.ts']);
    assert.equal((seed.meta as any).mode, 'summarized-nine-section');
  });
});

describe('TrimTranscriptWithSummaryTransformation', () => {
  it('appends summary seed after trimmed seed messages', async () => {
    const t = new TrimTranscriptWithSummaryTransformation();
    const snapshot = makeSnapshot([
      { role: 'user', content: 'do task', turn: 0 },
      { role: 'assistant', content: '', turn: 0, toolCalls: [{ name: 'read', arguments: '{"filePath":"a.js"}' }] },
      { role: 'tool', toolCallId: 'tc1', content: '{"success":true}', turn: 0 },
      { role: 'user', content: 'next', turn: 1 },
      { role: 'assistant', content: 'done', turn: 1 },
    ]);
    const seed = await t.transform({ sourceSnapshot: snapshot }, { llm: makeLLM('appended summary') });

    // trimmed history + 1 appended summary seed
    assert.ok(seed.seedMessages.length >= 2, 'should have trim messages plus appended summary');
    const last = seed.seedMessages[seed.seedMessages.length - 1];
    assert.equal(last.role, 'system');
    assert.ok(last.content.includes('appended summary'));
    assert.equal((seed.meta as any).mode, 'trim-transcript-with-summary');
  });
});
