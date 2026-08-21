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
    assert.ok(prompt.includes('大部分工具调用记录会被精简'));
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
