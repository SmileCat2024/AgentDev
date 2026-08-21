import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Notification } from '../../src/core/types.js';

// Mock DebugHub so emitNotification doesn't touch real transport
const mockPushNotification = vi.fn();
vi.mock('../../src/core/debug-hub.js', () => ({
  DebugHub: {
    getInstance: () => ({ pushNotification: mockPushNotification }),
  },
}));

import {
  emitNotification,
  runWithNotificationScope,
  createLLMCharCount,
  createLLMComplete,
  createToolStart,
  createToolComplete,
  createCallStart,
  createCallFinish,
  createLLMRetry,
  _setNotificationAgent,
  _getCurrentNotificationAgent,
  _clearNotificationAgent,
} from '../../src/core/notification.js';

describe('notification', () => {
  beforeEach(() => {
    mockPushNotification.mockReset();
    _clearNotificationAgent();
  });

  afterEach(() => {
    _clearNotificationAgent();
    vi.useRealTimers();
  });

  // ========== 上下文管理 ==========

  describe('通知上下文管理', () => {
    it('_setNotificationAgent 应设置当前 agentId', () => {
      _setNotificationAgent('agent-1');
      expect(_getCurrentNotificationAgent()).toBe('agent-1');
    });

    it('_getCurrentNotificationAgent 未设置时应返回 null', () => {
      expect(_getCurrentNotificationAgent()).toBeNull();
    });

    it('_clearNotificationAgent 应清除并返回 null', () => {
      _setNotificationAgent('agent-1');
      _clearNotificationAgent();
      expect(_getCurrentNotificationAgent()).toBeNull();
    });
  });

  // ========== emitNotification ==========

  describe('emitNotification', () => {
    it('无 agentId 时应静默忽略', () => {
      emitNotification({ type: 'test', category: 'state', timestamp: 0, data: {} });
      expect(mockPushNotification).not.toHaveBeenCalled();
    });

    it('有 agentId 时应调用 DebugHub.pushNotification', () => {
      _setNotificationAgent('agent-1');
      const notif: Notification = {
        type: 'custom',
        category: 'event',
        timestamp: 1000,
        data: { foo: 'bar' },
      };
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledWith('agent-1', notif);
    });

    it('event 类通知不应被节流', () => {
      _setNotificationAgent('agent-1');
      const notif: Notification = { type: 'test.event', category: 'event', timestamp: 0, data: {} };
      emitNotification(notif);
      emitNotification(notif);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(3);
    });

    it('call.start 应绕过节流', () => {
      _setNotificationAgent('agent-1');
      const notif: Notification = { type: 'call.start', category: 'state', timestamp: 0, data: {} };
      emitNotification(notif);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(2);
    });

    it('call.finish 应绕过节流', () => {
      _setNotificationAgent('agent-1');
      const notif: Notification = { type: 'call.finish', category: 'state', timestamp: 0, data: {} };
      emitNotification(notif);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(2);
    });

    it('llm.complete 应绕过节流', () => {
      _setNotificationAgent('agent-1');
      const notif: Notification = { type: 'llm.complete', category: 'state', timestamp: 0, data: {} };
      emitNotification(notif);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(2);
    });

    it('state 类通知在 100ms 内重复应被节流', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      _setNotificationAgent('agent-1');
      const notif: Notification = { type: 'llm.char_count', category: 'state', timestamp: 0, data: {} };

      emitNotification(notif);
      // 50ms 后 — 应被节流
      vi.setSystemTime(1050);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(1);

      // 101ms 后 — 应通过
      vi.setSystemTime(1101);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(2);
    });

    it('_clearNotificationAgent 应重置节流状态', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      _setNotificationAgent('agent-1');
      const notif: Notification = { type: 'llm.char_count', category: 'state', timestamp: 0, data: {} };

      emitNotification(notif); // 通过
      expect(mockPushNotification).toHaveBeenCalledTimes(1);

      _clearNotificationAgent();
      _setNotificationAgent('agent-2');

      // 即使时间没变，clear 后节流应重置
      vi.setSystemTime(1010);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(2);
      expect(mockPushNotification).toHaveBeenLastCalledWith('agent-2', notif);
    });
  });

  // ========== 通知工厂函数 ==========

  describe('通知工厂函数', () => {
    it('createLLMCharCount 应生成正确结构', () => {
      const notif = createLLMCharCount(500, 'content');
      expect(notif.type).toBe('llm.char_count');
      expect(notif.category).toBe('state');
      expect(notif.timestamp).toBeTypeOf('number');
      expect(notif.data).toMatchObject({ charCount: 500, phase: 'content' });
    });

    it('createLLMCharCount 应包含可选 extras 字段', () => {
      const notif = createLLMCharCount(1000, 'thinking', {
        thinkingChars: 600,
        contentChars: 400,
        toolCallCount: 3,
      });
      expect(notif.data).toMatchObject({
        charCount: 1000,
        phase: 'thinking',
        thinkingChars: 600,
        contentChars: 400,
        toolCallCount: 3,
      });
    });

    it('createLLMCharCount 不传 extras 时 data 不含可选字段', () => {
      const notif = createLLMCharCount(500, 'content');
      const data = notif.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('thinkingChars');
      expect(data).not.toHaveProperty('contentChars');
      expect(data).not.toHaveProperty('toolCallCount');
    });

    it('createLLMComplete 应生成正确结构', () => {
      const notif = createLLMComplete(2000);
      expect(notif.type).toBe('llm.complete');
      expect(notif.category).toBe('state');
      expect(notif.data).toMatchObject({ totalChars: 2000 });
    });

    it('createToolStart 应生成 event 类通知', () => {
      const notif = createToolStart('read');
      expect(notif.type).toBe('tool.start');
      expect(notif.category).toBe('event');
      expect(notif.data).toMatchObject({ toolName: 'read' });
    });

    it('createToolComplete 应包含 toolName/success/duration', () => {
      const notif = createToolComplete('write', true, 150);
      expect(notif.type).toBe('tool.complete');
      expect(notif.category).toBe('event');
      expect(notif.data).toMatchObject({ toolName: 'write', success: true, duration: 150 });
    });

    it('createToolComplete success=false 时应保持 false', () => {
      const notif = createToolComplete('bash', false, 0);
      expect(notif.data).toMatchObject({ toolName: 'bash', success: false, duration: 0 });
    });

    it('createCallStart 应生成 call.start 类型', () => {
      const notif = createCallStart();
      expect(notif.type).toBe('call.start');
      expect(notif.category).toBe('state');
      expect(notif.data).toEqual({});
    });

    it('createCallFinish 应携带完整 CallOutcome', () => {
      const outcome = {
        status: 'completed',
        reason: 'completed',
        response: 'done',
        steps: 2,
        startedAt: 1,
        finishedAt: 2,
      };
      const notif = createCallFinish(outcome);
      expect(notif.type).toBe('call.finish');
      expect(notif.category).toBe('state');
      expect(notif.data).toMatchObject({ status: 'completed', reason: 'completed' });
    });

    it('createCallFinish 失败终态应包含 error 事实', () => {
      const notif = createCallFinish({
        status: 'failed',
        reason: 'error',
        response: 'API 请求频率超限 (429)，请稍后重试',
        steps: 1,
        startedAt: 1,
        finishedAt: 2,
        error: { category: 'rate_limit', message: 'API 请求频率超限 (429)，请稍后重试', retryable: true },
      });
      expect(notif.data).toMatchObject({
        status: 'failed',
        reason: 'error',
        error: { category: 'rate_limit', retryable: true },
      });
    });

    it('createLLMRetry 应携带重试阶段与退避参数', () => {
      const notif = createLLMRetry({
        phase: 'waiting',
        attempt: 2,
        maxRetries: 10,
        delayMs: 800,
        errorType: 'rate_limit',
        statusCode: 429,
      });
      expect(notif.type).toBe('llm.retry');
      expect(notif.category).toBe('event');
      expect(notif.data).toMatchObject({ phase: 'waiting', attempt: 2, delayMs: 800, errorType: 'rate_limit' });
    });
  });

  // ========== streamToolNames 扩展字段 ==========

  describe('createLLMCharCount 流式扩展字段', () => {
    it('streamToolNames 非空数组时应包含在 data 中', () => {
      const notif = createLLMCharCount(100, 'tool_calling', {
        toolCallCount: 2,
        streamToolNames: ['read', 'edit'],
      });
      const data = notif.data as Record<string, unknown>;
      expect(data).toHaveProperty('streamToolNames');
      expect(data.streamToolNames).toEqual(['read', 'edit']);
    });

    it('streamToolNames 空数组时不应包含在 data 中', () => {
      const notif = createLLMCharCount(100, 'tool_calling', {
        streamToolNames: [],
      });
      const data = notif.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('streamToolNames');
    });

    it('不传 streamToolNames 时 data 不含该字段', () => {
      const notif = createLLMCharCount(100, 'content');
      const data = notif.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('streamToolNames');
    });
  });

  // ========== 阶段转换绕过节流 ==========

  describe('emitNotification 阶段转换绕过节流', () => {
    it('llm.char_count phase 变化时应绕过节流', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      _setNotificationAgent('agent-1');

      // 先发 thinking phase
      emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'thinking' } });
      expect(mockPushNotification).toHaveBeenCalledTimes(1);

      // 50ms 后切到 content phase — 应绕过节流
      vi.setSystemTime(1050);
      emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'content' } });
      expect(mockPushNotification).toHaveBeenCalledTimes(2);
    });

    it('同一 phase 在 100ms 内重复应被节流', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      _setNotificationAgent('agent-1');

      const notif = { type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'content' } };
      emitNotification(notif);
      // 50ms 后同 phase — 应被节流
      vi.setSystemTime(1050);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(1);
    });

    it('thinking → content → tool_calling 连续转换都应通过', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      _setNotificationAgent('agent-1');

      emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'thinking' } });
      vi.setSystemTime(1010);
      emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'content' } });
      vi.setSystemTime(1020);
      emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'tool_calling' } });

      expect(mockPushNotification).toHaveBeenCalledTimes(3);
    });

    it('_clearNotificationAgent 应重置 lastLLMPhase', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      _setNotificationAgent('agent-1');

      emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'thinking' } });
      expect(mockPushNotification).toHaveBeenCalledTimes(1);

      _clearNotificationAgent();
      _setNotificationAgent('agent-2');

      // clear 后同一 phase 也应通过
      vi.setSystemTime(1010);
      emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'thinking' } });
      expect(mockPushNotification).toHaveBeenCalledTimes(2);
      expect(mockPushNotification).toHaveBeenLastCalledWith('agent-2', expect.anything());
    });

    it('无 phase 字段的 llm.char_count 不触发阶段转换', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      _setNotificationAgent('agent-1');

      const notif = { type: 'llm.char_count', category: 'state', timestamp: 0, data: {} };
      emitNotification(notif);
      // 50ms 后重复 — 应被节流（phase 为空，不触发转换绕过）
      vi.setSystemTime(1050);
      emitNotification(notif);
      expect(mockPushNotification).toHaveBeenCalledTimes(1);
    });
  });
});
