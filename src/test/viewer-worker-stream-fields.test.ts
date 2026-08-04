import { describe, it, expect } from 'vitest';
import { ViewerWorker } from '../core/viewer-worker.js';

/**
 * Round-trip 测试：验证 streamToolNames 字段在
 * ViewerWorker 通知处理管线中的完整生命周期：
 *
 * 1. llm.char_count 通知携带 streamToolNames → runtimeState 存储
 * 2. llm.complete → 字段清除
 * 3. call.start → 字段清除
 * 4. call.finish → 字段清除
 * 5. cloneRuntimeState 正确克隆 streamToolNames
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-stream-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-stream-${process.pid}-${Date.now()}.sock`;
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

describe('ViewerWorker stream fields round-trip', () => {
  it('llm.char_count 携带 streamToolNames 时应存入 runtimeState', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'stream-tools-agent';
    worker.getOrCreateSession(agentId, 'Stream Tools Test');

    // 先触发 call.start 确保 callActive
    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 1000, data: {} },
    });

    // 发送 tool_calling 阶段的 char_count
    worker.handlePushNotification({
      agentId,
      notification: {
        type: 'llm.char_count',
        category: 'state',
        timestamp: 2000,
        data: {
          charCount: 150,
          phase: 'tool_calling',
          toolCallCount: 2,
          streamToolNames: ['read', 'edit'],
        },
      },
    });

    const res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    expect(res.getStatusCode()).toBe(200);
    const runtime = res.getJson().runtime;
    expect(runtime.streamToolNames).toEqual(['read', 'edit']);
    expect(runtime.toolCallCount).toBe(2);
    expect(runtime.stage).toBe('llm_tool_call_building');
  });

  it('llm.char_count 不携带 streamToolNames 时 runtimeState 中应为 undefined', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'stream-absent-agent';
    worker.getOrCreateSession(agentId, 'Stream Absent Test');

    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 1000, data: {} },
    });

    worker.handlePushNotification({
      agentId,
      notification: {
        type: 'llm.char_count',
        category: 'state',
        timestamp: 2000,
        data: { charCount: 100, phase: 'thinking' },
      },
    });

    const res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;
    expect(runtime.streamToolNames).toBeUndefined();
  });

  it('llm.complete 应清除 streamToolNames', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'stream-clear-complete';
    worker.getOrCreateSession(agentId, 'Stream Clear Complete');

    // call.start
    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 1000, data: {} },
    });

    // 设置 stream 字段
    worker.handlePushNotification({
      agentId,
      notification: {
        type: 'llm.char_count', category: 'state', timestamp: 2000,
        data: { charCount: 300, phase: 'tool_calling', toolCallCount: 1, streamToolNames: ['bash'] },
      },
    });

    // 验证已设置
    let res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    expect(res.getJson().runtime.streamToolNames).toEqual(['bash']);

    // llm.complete 清除
    worker.handlePushNotification({
      agentId,
      notification: { type: 'llm.complete', category: 'state', timestamp: 3000, data: { totalChars: 300 } },
    });

    res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;
    expect(runtime.streamToolNames).toBeUndefined();
  });

  it('call.start 应清除上一轮残留的 streamToolNames', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'stream-clear-start';
    worker.getOrCreateSession(agentId, 'Stream Clear Start');

    // 第一轮 call
    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 1000, data: {} },
    });
    worker.handlePushNotification({
      agentId,
      notification: {
        type: 'llm.char_count', category: 'state', timestamp: 2000,
        data: { charCount: 100, phase: 'tool_calling', toolCallCount: 1, streamToolNames: ['bash'] },
      },
    });

    // 验证已设置
    let res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    expect(res.getJson().runtime.streamToolNames).toEqual(['bash']);

    // 第二轮 call.start
    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 3000, data: {} },
    });

    res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;
    expect(runtime.streamToolNames).toBeUndefined();
  });

  it('call.finish 应清除 streamToolNames', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'stream-clear-finish';
    worker.getOrCreateSession(agentId, 'Stream Clear Finish');

    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 1000, data: {} },
    });
    worker.handlePushNotification({
      agentId,
      notification: {
        type: 'llm.char_count', category: 'state', timestamp: 2000,
        data: { charCount: 200, phase: 'tool_calling', toolCallCount: 1, streamToolNames: ['read'] },
      },
    });

    // call.finish
    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.finish', category: 'state', timestamp: 3000, data: { completed: true } },
    });

    const res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;
    expect(runtime.streamToolNames).toBeUndefined();
  });

  it('cloneRuntimeState 应深拷贝 streamToolNames 数组', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'stream-clone-agent';
    worker.getOrCreateSession(agentId, 'Stream Clone Test');

    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 1000, data: {} },
    });
    worker.handlePushNotification({
      agentId,
      notification: {
        type: 'llm.char_count', category: 'state', timestamp: 2000,
        data: { charCount: 50, phase: 'tool_calling', toolCallCount: 2, streamToolNames: ['read', 'write'] },
      },
    });

    const res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;

    // 克隆后的数组应是独立副本
    expect(Array.isArray(runtime.streamToolNames)).toBe(true);
    expect(runtime.streamToolNames).toEqual(['read', 'write']);
    expect(runtime.streamToolNames).not.toBe(['read', 'write']); // 不同引用
  });

  it('streamToolNames 中的非字符串元素应被过滤或转换', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'stream-filter-agent';
    worker.getOrCreateSession(agentId, 'Stream Filter Test');

    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 1000, data: {} },
    });
    worker.handlePushNotification({
      agentId,
      notification: {
        type: 'llm.char_count', category: 'state', timestamp: 2000,
        data: {
          charCount: 100, phase: 'tool_calling', toolCallCount: 2,
          streamToolNames: ['read', null, 42, '', 'edit', undefined],
        },
      },
    });

    const res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;
    expect(runtime.streamToolNames).toEqual(['read', '42', 'edit']);
  });
});
