/**
 * 导出面导入冒烟测试（tickets 001/002/003 统一创建）。
 *
 * 断言各批新增的公共类型均可从入口 `../index.js`（即包入口 `agentdev`）
 * 以 `import type` 解析，并做最小字段级冒烟，防止引用闭包重新出现
 * “已导出类型引用了不可导入类型”的缺口。
 *
 * 注册走 vitest（框架测试体系 = `npm test` 即 vitest run，自动发现
 * src/test/**​/*.test.ts），断言用 node:assert/strict（node:test 惯用格式，
 * 与仓库既有节点风格测试保持一致）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type {
  // 001：usage 类型族
  UsageInfo,
  UsageStatsSnapshot,
  CallUsageSummary,
  UsageStats,
  // 002：通知版运行时状态快照
  AgentRuntimeStateSnapshot,
  RuntimeStage,
  // 003：引用闭包补齐
  FeatureCheckpoint,
  ToolExecResult,
  ContextTombstoneSummary,
  ContextTombstoneEntry,
  // 003 后续修复：ContextSnapshot 引用闭包（早于本批即存在的缺口）
  EnrichedMessage,
  MessageTag,
  ParsedContent,
} from '../index.js';

test('001: usage 类型族可从入口解析', () => {
  const usage: UsageInfo = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
  const call: CallUsageSummary = {
    callIndex: 0,
    totalUsage: usage,
    stepCount: 1,
    cacheHitRequests: 0,
    startTime: 1,
  };
  const snapshot: UsageStatsSnapshot = {
    totalUsage: usage,
    calls: [call],
    totalRequests: 1,
    totalCacheHitRequests: 0,
  };
  assert.equal(snapshot.totalRequests, 1);
  // UsageStats 为 type-only 导出（类不扩大运行时面），仅作类型引用以验证可解析
  const t: UsageStats = null as unknown as UsageStats;
  assert.ok(t === null);
});

test('002: 通知版运行时状态快照与 stage 可从入口解析', () => {
  const runtime: AgentRuntimeStateSnapshot = {
    stage: 'idle',
    callActive: false,
    charCount: 0,
    thinkingChars: 0,
    contentChars: 0,
    toolCallCount: 0,
    activeToolNames: [],
    activeToolCount: 0,
    updatedAt: 0,
  };
  const stage: RuntimeStage = 'tool_executing';
  assert.equal(runtime.stage, 'idle');
  assert.equal(stage, 'tool_executing');
});

test('003: 引用闭包补齐类型可从入口解析', () => {
  const toolResult: ToolExecResult = { success: true, result: 'ok' };
  assert.equal(toolResult.success, true);

  const summary: ContextTombstoneSummary = {
    id: 1,
    boundary: { messagesLength: 0, enrichedMessagesLength: 0, sequence: 0, generation: 0 },
    removedMessageCount: 2,
    truncatedAt: 'now',
  };
  const entry: ContextTombstoneEntry = {
    ...summary,
    removedMessages: [],
    removedEnrichedMessages: [],
  };
  assert.equal(entry.removedMessageCount, 2);

  const checkpoint: FeatureCheckpoint = { featureName: 'demo', snapshot: {} };
  assert.equal(checkpoint.featureName, 'demo');
});

test('003-fix: EnrichedMessage 引用闭包可从入口解析', () => {
  const tag: MessageTag = 'assistant';
  const parsed: ParsedContent = { taskIds: [], toolCalls: [], mentions: [] };
  const enriched: EnrichedMessage = {
    role: 'assistant',
    content: 'hello',
    id: 'm1',
    timestamp: 0,
    turn: 0,
    sequence: 0,
    tags: [tag],
    parsed,
  };
  assert.equal(enriched.tags[0], 'assistant');
  assert.equal(enriched.parsed.taskIds.length, 0);
});
