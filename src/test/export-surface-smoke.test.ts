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
  // 005：Session Continuity 契约层
  SessionTransformation,
  TransformInput,
  TransformContext,
  SuccessorSeed,
  SessionSeedMessage,
  SessionContinuityEntry,
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

test('005: Session Continuity 契约类型可从入口解析', () => {
  // 最小 SuccessorSeed：schemaVersion 必填，seedMessages 为种子消息。
  const seed: SuccessorSeed = {
    schemaVersion: 1,
    seedMessages: [{ role: 'system', content: 'continuation' }],
  };
  assert.equal(seed.schemaVersion, 1);
  assert.equal(seed.seedMessages[0].content, 'continuation');

  // 完整 SuccessorSeed：按 handoff JSON v1 蓝本框架化的全部可选载荷。
  const fullSeed: SuccessorSeed = {
    schemaVersion: 1,
    seedMessages: [{ role: 'assistant', content: 'ok', turn: 3 }],
    featureContinuity: [
      { featureName: 'todo', protocol: 'example.feature-continuity.v1', state: { tasks: [] } },
    ],
    importantFiles: ['src/core/continuity/index.ts'],
    importantSkills: ['implement'],
    fileRanges: { 'src/core/continuity/index.ts': '1-160' },
    meta: { sourceSessionId: 's1' },
  };
  assert.equal(fullSeed.importantFiles!.length, 1);
  assert.equal(fullSeed.featureContinuity?.[0].protocol, 'example.feature-continuity.v1');
  assert.equal(fullSeed.fileRanges?.['src/core/continuity/index.ts'], '1-160');

  // 窄契约输入：sourceSnapshot 复用 session-store 快照，policy 为自由策略面。
  const input: TransformInput = {
    sourceSnapshot: {
      version: 1,
      sessionId: 's1',
      savedAt: 0,
      agentType: 'basic',
      runtime: { initialized: true, callIndex: 0, featureStates: [] },
      rollbackHistory: [],
    },
    policy: { strategy: 'trim-transcript' },
  };
  assert.equal(input.policy?.strategy, 'trim-transcript');

  // 变换上下文：llm 为宿主注入的进程内 LLM 基座（摘要变换执行底座）。
  const ctx: TransformContext = {
    llm: {
      async chat() {
        return { content: 'summary' };
      },
    },
  };

  // 变换窄契约：id + transform(input, ctx) → Promise<SuccessorSeed>。
  const transformation: SessionTransformation = {
    id: 'agentdev.summary',
    async transform() {
      return seed;
    },
  };
  assert.equal(transformation.id, 'agentdev.summary');

  // 契约-级检查：SuccessorSeed / SessionSeedMessage 的键集合不包含任何 Claw 私有概念。
  const seedKeys = new Set(['schemaVersion', 'seedMessages', 'featureContinuity', 'importantFiles', 'importantSkills', 'fileRanges', 'meta']);
  for (const key of Object.keys(seed)) {
    assert.ok(seedKeys.has(key), `unexpected SuccessorSeed key: ${key}`);
  }
  const messageKeys = new Set(['role', 'content', 'turn', 'toolCallId', 'toolCalls', 'reasoning', 'thinkingBlocks', 'images', 'tag']);
  for (const key of Object.keys(seed.seedMessages[0])) {
    assert.ok(messageKeys.has(key), `unexpected SessionSeedMessage key: ${key}`);
  }
  // 窄契约输入/输出类型均为 framework 中性概念；显式引用种子消息承载类型以防改名遗漏。
  const sm: SessionSeedMessage = { role: 'user', content: 'hi' };
  const entry: SessionContinuityEntry = { featureName: 'f', protocol: 'p', state: null as unknown };
  assert.equal(sm.role, 'user');
  assert.equal(entry.protocol, 'p');
});
