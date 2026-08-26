import { describe, it, expect } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';
import type { AgentOverviewSnapshot } from '@agentdevjs/core';

/**
 * Round-trip 测试：验证 overview snapshot 经过 ViewerWorker 的
 * write (handleUpdateAgentOverview) → read (handleGetAgentOverview → getMergedOverview)
 * 管线后，所有字段完整保留。
 *
 * handleUpdateAgentOverview 使用 spread，getMergedOverview 也使用 spread，
 * 理论上不会丢字段。但此测试锁定这一行为，防止未来重构引入字段剥离。
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-overview-roundtrip-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-overview-roundtrip-${process.pid}-${Date.now()}.sock`;
}

function createMockRes() {
  let statusCode = 0;
  let body = '';
  return {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { body = data; },
    getStatusCode() { return statusCode; },
    getJson() { return JSON.parse(body); },
  };
}

function buildFullOverview(): AgentOverviewSnapshot {
  return {
    updatedAt: 1700000000000,
    context: {
      messageCount: 42,
      charCount: 12345,
      toolCallCount: 7,
      turnCount: 5,
    },
    usageStats: {
      totalUsage: {
        inputTokens: 10000,
        outputTokens: 5000,
        totalTokens: 15000,
        cacheCreationTokens: 3000,
        cacheReadTokens: 2000,
        reasoningTokens: 800,
        audioTokens: 100,
      },
      calls: [
        {
          callIndex: 0,
          totalUsage: {
            inputTokens: 5000,
            outputTokens: 2500,
            totalTokens: 7500,
          },
          stepCount: 3,
          cacheHitRequests: 1,
          startTime: 1700000001000,
          endTime: 1700000002000,
        },
      ],
      totalRequests: 4,
      totalCacheHitRequests: 1,
      lastRequestUsage: {
        inputTokens: 2000,
        outputTokens: 1000,
        totalTokens: 3000,
      },
    },
    runtime: {
      stage: 'idle',
      callActive: false,
      charCount: 12345,
      thinkingChars: 0,
      contentChars: 12345,
      toolCallCount: 7,
      activeToolNames: [],
      activeToolCount: 0,
      callStartedAt: 0,
      stageStartedAt: 0,
      updatedAt: 1700000003000,
      lastErrorType: null,
      lastErrorMessage: null,
    },
    modelName: 'gpt-4-test',
    presetName: 'gpt-4-test-preset',
    thinkingEffort: 'high',
    contextLength: 128000,
    compressRatio: 75,
  };
}

describe('ViewerWorker overview round-trip', () => {
  it('preserves modelName through write → read round-trip', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'overview-model-agent';
    worker.getOrCreateSession(agentId, 'Overview ModelName');

    worker.handleUpdateAgentOverview({ agentId, overview: buildFullOverview() });

    const res = createMockRes();
    worker.handleGetAgentOverview({} as any, res as any, agentId);

    expect(res.getStatusCode()).toBe(200);
    const output = res.getJson();
    expect(output.modelName).toBe('gpt-4-test');
  });

  it('preserves context metrics through round-trip', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'overview-context-agent';
    worker.getOrCreateSession(agentId, 'Overview Context');

    worker.handleUpdateAgentOverview({ agentId, overview: buildFullOverview() });

    const res = createMockRes();
    worker.handleGetAgentOverview({} as any, res as any, agentId);

    const output = res.getJson();
    expect(output.context.messageCount).toBe(42);
    expect(output.context.charCount).toBe(12345);
    expect(output.context.toolCallCount).toBe(7);
    expect(output.context.turnCount).toBe(5);
  });

  it('preserves usageStats including optional token fields through round-trip', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'overview-usage-agent';
    worker.getOrCreateSession(agentId, 'Overview Usage');

    worker.handleUpdateAgentOverview({ agentId, overview: buildFullOverview() });

    const res = createMockRes();
    worker.handleGetAgentOverview({} as any, res as any, agentId);

    const output = res.getJson();
    // 核心 token 字段
    expect(output.usageStats.totalUsage.inputTokens).toBe(10000);
    expect(output.usageStats.totalUsage.outputTokens).toBe(5000);
    expect(output.usageStats.totalUsage.totalTokens).toBe(15000);
    // 可选 token 字段（Anthropic/OpenAI 特有）
    expect(output.usageStats.totalUsage.cacheCreationTokens).toBe(3000);
    expect(output.usageStats.totalUsage.cacheReadTokens).toBe(2000);
    expect(output.usageStats.totalUsage.reasoningTokens).toBe(800);
    expect(output.usageStats.totalUsage.audioTokens).toBe(100);
    // 请求统计
    expect(output.usageStats.totalRequests).toBe(4);
    expect(output.usageStats.totalCacheHitRequests).toBe(1);
    // lastRequestUsage
    expect(output.usageStats.lastRequestUsage.totalTokens).toBe(3000);
  });

  it('preserves calls array with all fields through round-trip', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'overview-calls-agent';
    worker.getOrCreateSession(agentId, 'Overview Calls');

    worker.handleUpdateAgentOverview({ agentId, overview: buildFullOverview() });

    const res = createMockRes();
    worker.handleGetAgentOverview({} as any, res as any, agentId);

    const output = res.getJson();
    expect(output.usageStats.calls).toHaveLength(1);
    const call = output.usageStats.calls[0];
    expect(call.callIndex).toBe(0);
    expect(call.totalUsage.totalTokens).toBe(7500);
    expect(call.stepCount).toBe(3);
    expect(call.cacheHitRequests).toBe(1);
    expect(call.startTime).toBe(1700000001000);
    expect(call.endTime).toBe(1700000002000);
  });

  it('preserves all agent-injected model fields through round-trip', () => {
    // These fields are injected by Agent.buildOverviewSnapshot() from _llmMeta.
    // They must survive the ViewerWorker write → read pipeline so the frontend
    // context bar can reflect model hot-swaps in real time. Historically
    // contextLength/compressRatio were missing from the snapshot entirely;
    // this test locks them down alongside modelName/presetName/thinkingEffort.
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'overview-model-fields-agent';
    worker.getOrCreateSession(agentId, 'Overview Model Fields');

    worker.handleUpdateAgentOverview({ agentId, overview: buildFullOverview() });

    const res = createMockRes();
    worker.handleGetAgentOverview({} as any, res as any, agentId);

    const output = res.getJson();
    expect(output.modelName).toBe('gpt-4-test');
    expect(output.presetName).toBe('gpt-4-test-preset');
    expect(output.thinkingEffort).toBe('high');
    expect(output.contextLength).toBe(128000);
    expect(output.compressRatio).toBe(75);
  });
});
