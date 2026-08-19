/**
 * notification 并发隔离测试
 *
 * 验证 runWithNotificationScope 使用 AsyncLocalStorage 实现的 per-call 上下文隔离。
 * 核心场景：同一进程内两个并发的 agent onCall()，各自的通知应该路由到正确的 agentId。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Notification } from '../../core/types.js';

// Mock DebugHub
const mockPushNotification = vi.fn();
vi.mock('../../core/debug-hub.js', () => ({
  DebugHub: {
    getInstance: () => ({ pushNotification: mockPushNotification }),
  },
}));

import {
  runWithNotificationScope,
  emitNotification,
  _setNotificationAgent,
  _clearNotificationAgent,
  _getCurrentNotificationAgent,
  createCallStart,
  createCallFinish,
  createLLMCharCount,
} from '../../core/notification.js';

describe('notification 并发隔离 (AsyncLocalStorage)', () => {
  beforeEach(() => {
    mockPushNotification.mockReset();
    _clearNotificationAgent();
  });

  afterEach(() => {
    _clearNotificationAgent();
    vi.useRealTimers();
  });

  // ========== runWithNotificationScope 基础行为 ==========

  describe('runWithNotificationScope 基础行为', () => {
    it('在 scope 内 emitNotification 应使用 scope 的 agentId', () => {
      runWithNotificationScope('agent-A', () => {
        emitNotification(createCallStart());
        expect(mockPushNotification).toHaveBeenCalledWith('agent-A', expect.anything());
      });
    });

    it('scope 外 emitNotification 不应发送（无 agentId）', () => {
      emitNotification(createCallStart());
      expect(mockPushNotification).not.toHaveBeenCalled();
    });

    it('scope 结束后 agentId 应回到无状态', () => {
      runWithNotificationScope('agent-A', () => {
        expect(_getCurrentNotificationAgent()).toBe('agent-A');
      });
      expect(_getCurrentNotificationAgent()).toBeNull();
    });

    it('同步返回值应正确传递', () => {
      const result = runWithNotificationScope('agent-A', () => {
        return 'hello';
      });
      expect(result).toBe('hello');
    });

    it('异步返回值应正确传递', async () => {
      const result = await runWithNotificationScope('agent-A', async () => {
        return Promise.resolve(42);
      });
      expect(result).toBe(42);
    });
  });

  // ========== 并发隔离 ==========

  describe('并发 scope 隔离', () => {
    it('两个并发 scope 各自发送通知应路由到正确 agentId', async () => {
      const agentANotifs: string[] = [];
      const agentBNotifs: string[] = [];

      const taskA = runWithNotificationScope('agent-A', async () => {
        // 模拟 onCall 中的通知发送
        for (let i = 0; i < 3; i++) {
          emitNotification(createLLMCharCount(100 * (i + 1), 'content'));
          // 在 agentA 的 scope 内，收集 agentId
          const agentId = _getCurrentNotificationAgent();
          if (agentId) agentANotifs.push(agentId);
          await new Promise(r => setTimeout(r, 1)); // 让出事件循环
        }
      });

      const taskB = runWithNotificationScope('agent-B', async () => {
        for (let i = 0; i < 3; i++) {
          emitNotification(createLLMCharCount(200 * (i + 1), 'content'));
          const agentId = _getCurrentNotificationAgent();
          if (agentId) agentBNotifs.push(agentId);
          await new Promise(r => setTimeout(r, 1));
        }
      });

      await Promise.all([taskA, taskB]);

      // agentA 的所有通知都应该路由到 agent-A
      expect(agentANotifs.every(id => id === 'agent-A')).toBe(true);
      expect(agentBNotifs.every(id => id === 'agent-B')).toBe(true);

      // pushNotification 应被调用了至少 2 次（每个 agent 至少 1 次）
      expect(mockPushNotification.mock.calls.length).toBeGreaterThanOrEqual(2);

      // 验证每次调用都用了正确的 agentId
      const allCalls = mockPushNotification.mock.calls;
      const agentACalls = allCalls.filter(c => c[0] === 'agent-A');
      const agentBCalls = allCalls.filter(c => c[0] === 'agent-B');
      expect(agentACalls.length).toBeGreaterThanOrEqual(1);
      expect(agentBCalls.length).toBeGreaterThanOrEqual(1);

      // 确保没有路由串扰
      const wrongCalls = allCalls.filter(c => c[0] !== 'agent-A' && c[0] !== 'agent-B');
      expect(wrongCalls).toHaveLength(0);
    });

    it('交错 await 边界后 agentId 应保持隔离', async () => {
      const results: Array<{ step: string; agentId: string | null }> = [];

      await Promise.all([
        runWithNotificationScope('agent-X', async () => {
          results.push({ step: 'X-start', agentId: _getCurrentNotificationAgent() });
          await new Promise(r => setTimeout(r, 5));
          results.push({ step: 'X-after-yield', agentId: _getCurrentNotificationAgent() });
        }),
        runWithNotificationScope('agent-Y', async () => {
          await new Promise(r => setTimeout(r, 1));
          results.push({ step: 'Y-start', agentId: _getCurrentNotificationAgent() });
          await new Promise(r => setTimeout(r, 10));
          results.push({ step: 'Y-after-yield', agentId: _getCurrentNotificationAgent() });
        }),
      ]);

      const xResults = results.filter(r => r.step.startsWith('X'));
      const yResults = results.filter(r => r.step.startsWith('Y'));

      expect(xResults.every(r => r.agentId === 'agent-X')).toBe(true);
      expect(yResults.every(r => r.agentId === 'agent-Y')).toBe(true);
    });
  });

  // ========== 节流状态隔离 ==========

  describe('节流状态 per-scope 隔离', () => {
    it('两个 scope 各自的节流状态不应互相干扰', () => {
      vi.useFakeTimers();

      // agent-A 在 t=1000 发一条 state 通知
      vi.setSystemTime(1000);
      runWithNotificationScope('agent-A', () => {
        emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'content' } });
      });
      const agentACallCountAfterFirst = mockPushNotification.mock.calls.length;

      // agent-B 在 t=1010（仍在节流窗口内）也应能发通知（独立节流）
      vi.setSystemTime(1010);
      runWithNotificationScope('agent-B', () => {
        emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'content' } });
      });

      // agent-B 的通知不应被 agent-A 的节流状态阻止
      expect(mockPushNotification.mock.calls.length).toBeGreaterThan(agentACallCountAfterFirst);

      // 最后一次调用应路由到 agent-B
      const lastCall = mockPushNotification.mock.calls[mockPushNotification.mock.calls.length - 1];
      expect(lastCall[0]).toBe('agent-B');
    });

    it('同一 scope 内的节流仍应生效', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      runWithNotificationScope('agent-A', () => {
        const notif: Notification = { type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'content' } };
        emitNotification(notif);
        // 50ms 后同 phase 同 type — 应被节流
        vi.setSystemTime(1050);
        emitNotification(notif);
      });

      // 只应发一次
      expect(mockPushNotification).toHaveBeenCalledTimes(1);
    });
  });

  // ========== LLM 阶段跟踪隔离 ==========

  describe('LLM 阶段跟踪 per-scope 隔离', () => {
    it('两个 scope 独立跟踪 phase 转换', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);

      // agent-A 先发 thinking
      runWithNotificationScope('agent-A', () => {
        emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'thinking' } });
      });
      expect(mockPushNotification).toHaveBeenCalledTimes(1);

      // agent-B 也发 thinking — 应通过（独立 phase 跟踪）
      vi.setSystemTime(1010);
      runWithNotificationScope('agent-B', () => {
        emitNotification({ type: 'llm.char_count', category: 'state', timestamp: 0, data: { phase: 'thinking' } });
      });
      expect(mockPushNotification).toHaveBeenCalledTimes(2);
      expect(mockPushNotification.mock.calls[1][0]).toBe('agent-B');
    });
  });

  // ========== 与旧 API 的向后兼容 ==========

  describe('向后兼容：模块级 fallback', () => {
    it('无 scope 时 _setNotificationAgent 仍应工作', () => {
      _setNotificationAgent('legacy-agent');
      expect(_getCurrentNotificationAgent()).toBe('legacy-agent');

      emitNotification(createCallStart());
      expect(mockPushNotification).toHaveBeenCalledWith('legacy-agent', expect.anything());
    });

    it('scope 内 _getCurrentNotificationAgent 应优先返回 scope 的 agentId', () => {
      _setNotificationAgent('legacy-agent');

      runWithNotificationScope('scope-agent', () => {
        expect(_getCurrentNotificationAgent()).toBe('scope-agent');
      });

      // scope 结束后回退到 module-level
      expect(_getCurrentNotificationAgent()).toBe('legacy-agent');
    });

    it('_clearNotificationAgent 应清除 module-level fallback', () => {
      _setNotificationAgent('legacy-agent');
      _clearNotificationAgent();
      expect(_getCurrentNotificationAgent()).toBeNull();
    });
  });

  // ========== round-trip 字段透传验证 ==========

  describe('round-trip 字段透传', () => {
    it('call.start 通知应完整透传 agentId + type + category + data', () => {
      runWithNotificationScope('rt-agent', () => {
        emitNotification(createCallStart());
      });

      expect(mockPushNotification).toHaveBeenCalledTimes(1);
      const [agentId, notif] = mockPushNotification.mock.calls[0];
      expect(agentId).toBe('rt-agent');
      expect(notif.type).toBe('call.start');
      expect(notif.category).toBe('state');
      expect(notif.data).toEqual({});
      expect(notif.timestamp).toBeTypeOf('number');
    });

    it('call.finish 通知应完整透传 CallOutcome', () => {
      runWithNotificationScope('rt-agent', () => {
        emitNotification(createCallFinish({
          status: 'cancelled',
          reason: 'cancelled',
          response: '',
          steps: 3,
          startedAt: 1,
          finishedAt: 2,
        }));
      });

      const [, notif] = mockPushNotification.mock.calls[0];
      expect(notif.type).toBe('call.finish');
      expect(notif.data).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    });

    it('llm.char_count 通知应完整透传 charCount + phase + extras', () => {
      runWithNotificationScope('rt-agent', () => {
        emitNotification(createLLMCharCount(1234, 'content', {
          thinkingChars: 500,
          contentChars: 734,
          toolCallCount: 3,
          streamToolNames: ['read', 'write'],
        }));
      });

      const [, notif] = mockPushNotification.mock.calls[0];
      expect(notif.type).toBe('llm.char_count');
      expect(notif.data).toMatchObject({
        charCount: 1234,
        phase: 'content',
        thinkingChars: 500,
        contentChars: 734,
        toolCallCount: 3,
        streamToolNames: ['read', 'write'],
      });
    });
  });
});
