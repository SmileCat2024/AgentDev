/**
 * DebugHub interruptHandler per-agent 隔离测试
 *
 * 验证多个 agent 可以各自注册中断处理器，
 * 当 interrupt-agent 消息到达时，只有对应 agentId 的 handler 被调用。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DebugHub } from '../../src/core/debug-hub.js';

describe('DebugHub interruptHandler per-agent 隔离', () => {
  let hub: DebugHub;

  beforeEach(() => {
    hub = DebugHub.getInstance();
  });

  afterEach(() => {
    hub.setInterruptHandler(undefined);
    for (const id of ['agent-A', 'agent-B', 'agent-SPECIAL', 'agent-UNKNOWN', 'agent-OTHER']) {
      hub.setInterruptHandler(id);
    }
  });

  it('setInterruptHandler(agentId, handler) 应注册 per-agent handler', () => {
    const handlerA = vi.fn();
    hub.setInterruptHandler('agent-A', handlerA);

    // 模拟 interrupt-agent 消息
    hub.handleWorkerMessage({
      type: 'interrupt-agent',
      agentId: 'agent-A',
      clearQueue: false,
    });

    expect(handlerA).toHaveBeenCalledWith('agent-A', false);
  });

  it('不同 agentId 的 handler 不应互相调用', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    hub.setInterruptHandler('agent-A', handlerA);
    hub.setInterruptHandler('agent-B', handlerB);

    // 中断 agent-A
    hub.handleWorkerMessage({
      type: 'interrupt-agent',
      agentId: 'agent-A',
      clearQueue: true,
    });

    expect(handlerA).toHaveBeenCalledWith('agent-A', true);
    expect(handlerB).not.toHaveBeenCalled();

    // 中断 agent-B
    hub.handleWorkerMessage({
      type: 'interrupt-agent',
      agentId: 'agent-B',
      clearQueue: false,
    });

    expect(handlerB).toHaveBeenCalledWith('agent-B', false);
    expect(handlerA).toHaveBeenCalledTimes(1); // 仍然是只被调用一次
  });

  it('未注册的 agentId 中断不应调用任何 per-agent handler', () => {
    const handlerA = vi.fn();
    hub.setInterruptHandler('agent-A', handlerA);

    hub.handleWorkerMessage({
      type: 'interrupt-agent',
      agentId: 'agent-UNKNOWN',
      clearQueue: false,
    });

    expect(handlerA).not.toHaveBeenCalled();
  });

  it('向后兼容：旧式 setInterruptHandler(handler) 应作为全局 fallback', () => {
    const globalHandler = vi.fn();
    // 旧式调用：只传一个 handler 函数
    hub.setInterruptHandler(globalHandler);

    hub.handleWorkerMessage({
      type: 'interrupt-agent',
      agentId: 'any-agent',
      clearQueue: false,
    });

    expect(globalHandler).toHaveBeenCalledWith('any-agent', false);
  });

  it('per-agent handler 应优先于全局 fallback', () => {
    const globalHandler = vi.fn();
    const specificHandler = vi.fn();

    hub.setInterruptHandler(globalHandler);
    hub.setInterruptHandler('agent-SPECIAL', specificHandler);

    // 对 agent-SPECIAL 的中断应调用 specificHandler，不调用 globalHandler
    hub.handleWorkerMessage({
      type: 'interrupt-agent',
      agentId: 'agent-SPECIAL',
      clearQueue: true,
    });

    expect(specificHandler).toHaveBeenCalledWith('agent-SPECIAL', true);
    expect(globalHandler).not.toHaveBeenCalled();

    // 对其他 agent 的中断应回退到 globalHandler
    hub.handleWorkerMessage({
      type: 'interrupt-agent',
      agentId: 'agent-OTHER',
      clearQueue: false,
    });

    expect(globalHandler).toHaveBeenCalledWith('agent-OTHER', false);
  });

  it('重复注册同一 agentId 应覆盖旧 handler', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    hub.setInterruptHandler('agent-A', handler1);
    hub.setInterruptHandler('agent-A', handler2);

    hub.handleWorkerMessage({
      type: 'interrupt-agent',
      agentId: 'agent-A',
      clearQueue: false,
    });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledWith('agent-A', false);
  });

  it('disposer should remove only the handler registration it owns', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const dispose1 = hub.setInterruptHandler('agent-A', handler1);
    hub.setInterruptHandler('agent-A', handler2);

    dispose1();
    hub.handleWorkerMessage({ type: 'interrupt-agent', agentId: 'agent-A', clearQueue: false });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('unregisterAgent should remove the matching interrupt handler', () => {
    const fakeAgent = { constructor: { name: 'InterruptCleanupAgent' } } as any;
    const agentId = hub.registerAgent(fakeAgent, 'InterruptCleanupAgent');
    const handler = vi.fn();
    hub.setInterruptHandler(agentId, handler);

    hub.unregisterAgent(agentId);
    hub.handleWorkerMessage({ type: 'interrupt-agent', agentId, clearQueue: false });

    expect(handler).not.toHaveBeenCalled();
  });
});
