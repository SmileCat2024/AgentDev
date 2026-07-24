import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Notification } from '../../core/types.js';

// Mock DebugHub so emitNotification doesn't touch real transport
const mockPushNotification = vi.fn();
vi.mock('../../core/debug-hub.js', () => ({
  DebugHub: {
    getInstance: () => ({ pushNotification: mockPushNotification }),
  },
}));

import {
  _setNotificationAgent,
  _clearNotificationAgent,
  _getCurrentNotificationAgent,
  emitNotification,
  createLLMCharCount,
  createLLMComplete,
  createToolStart,
  createToolComplete,
  createCallStart,
  createCallFinish,
} from '../../core/notification.js';

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

    it('createCallFinish 应包含 completed 字段', () => {
      const notif = createCallFinish(true);
      expect(notif.type).toBe('call.finish');
      expect(notif.category).toBe('state');
      expect(notif.data).toMatchObject({ completed: true });
    });

    it('createCallFinish 带 finishReason 时应包含该字段', () => {
      const notif = createCallFinish(false, 'interrupted');
      expect(notif.data).toMatchObject({ completed: false, finishReason: 'interrupted' });
    });

    it('createCallFinish 不带 finishReason 时不应包含该字段', () => {
      const notif = createCallFinish(true);
      const data = notif.data as Record<string, unknown>;
      expect(data).not.toHaveProperty('finishReason');
    });
  });
});
