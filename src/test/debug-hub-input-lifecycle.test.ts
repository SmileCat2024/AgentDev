import { describe, expect, it, vi } from 'vitest';
import { DebugHub } from '../core/debug-hub.js';

describe('DebugHub input request lifecycle', () => {
  it('rejects pending input when its Agent is unregistered', async () => {
    const hub = DebugHub.getInstance();
    const fakeAgent = { constructor: { name: 'PendingInputAgent' } } as any;
    const agentId = hub.registerAgent(fakeAgent, 'PendingInputAgent');
    const pending = hub.requestUserInputEvent(agentId, { prompt: 'wait forever' });

    hub.unregisterAgent(agentId);

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('unregistered'),
    });
    expect((hub as any).pendingInputRequests.size).toBe(0);
    expect((hub as any).activeInputRequests.has(agentId)).toBe(false);
  });

  it('cancelInputRequests is agent-scoped and idempotent', async () => {
    const hub = DebugHub.getInstance();
    const agentA = { constructor: { name: 'PendingA' } } as any;
    const agentB = { constructor: { name: 'PendingB' } } as any;
    const agentAId = hub.registerAgent(agentA, 'PendingA');
    const agentBId = hub.registerAgent(agentB, 'PendingB');
    const pendingA = hub.requestUserInputEvent(agentAId, { prompt: 'A' });
    const pendingB = hub.requestUserInputEvent(agentBId, { prompt: 'B' }, 20);

    hub.cancelInputRequests(agentAId, 'cancel A');
    hub.cancelInputRequests(agentAId, 'cancel A again');

    await expect(pendingA).rejects.toMatchObject({ name: 'AbortError', message: 'cancel A' });
    await expect(pendingB).rejects.toThrow('timeout');

    hub.unregisterAgent(agentAId);
    hub.unregisterAgent(agentBId);
  });

  it('enforces one input lease per Agent', async () => {
    const hub = DebugHub.getInstance();
    const fakeAgent = { constructor: { name: 'SingleLease' } } as any;
    const agentId = hub.registerAgent(fakeAgent, 'SingleLease');
    const first = hub.requestUserInputEvent(agentId, { prompt: 'first' });

    await expect(hub.requestUserInputEvent(agentId, { prompt: 'second' }))
      .rejects.toThrow('already has an active user input lease');

    hub.cancelInputRequests(agentId, 'test cleanup');
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    hub.unregisterAgent(agentId);
  });

  it('cancels pending input and notifies the worker when an interrupt is accepted', async () => {
    const hub = DebugHub.getInstance();
    const agent = {
      constructor: { name: 'InterruptedAgent' },
      interrupt: () => true,
    } as any;
    const agentId = hub.registerAgent(agent, 'InterruptedAgent');
    const pending = hub.requestUserInputEvent(agentId, { prompt: 'choose', mode: 'choices' });
    const expectedRequestId = (hub as any).activeInputRequests.get(agentId).requestId as string;
    const workerMessages: Array<{ type: string; agentId: string; requestId: string }> = [];
    const spy = vi.spyOn(hub as any, 'sendToWorker').mockImplementation((msg: any) => {
      workerMessages.push(msg);
    });

    // 模拟 ViewerWorker 转发来的中断消息（tool 内的 choices 等待被 abort 丢弃）
    (hub as any).handleWorkerMessage({ type: 'interrupt-agent', agentId, clearQueue: true });

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('interrupted'),
    });
    expect((hub as any).activeInputRequests.has(agentId)).toBe(false);
    expect(workerMessages).toContainEqual({
      type: 'input-request-cancelled',
      agentId,
      requestId: expectedRequestId,
    });

    // 宿主输入循环可以立即重开新租约（不再被 "already has an active user input lease" 拒绝）
    const reopened = hub.requestUserInputEvent(agentId, { prompt: '请输入' });
    expect((hub as any).activeInputRequests.has(agentId)).toBe(true);

    spy.mockRestore();
    hub.cancelInputRequests(agentId, 'cleanup');
    await expect(reopened).rejects.toMatchObject({ name: 'AbortError' });
    hub.unregisterAgent(agentId);
  });

  it('keeps an idle host input lease when the interrupt is not accepted', async () => {
    const hub = DebugHub.getInstance();
    const agent = {
      constructor: { name: 'IdleAgent' },
      interrupt: () => false,
    } as any;
    const agentId = hub.registerAgent(agent, 'IdleAgent');
    const pending = hub.requestUserInputEvent(agentId, { prompt: 'idle slot' });
    const spy = vi.spyOn(hub as any, 'sendToWorker').mockImplementation(() => {});

    (hub as any).handleWorkerMessage({ type: 'interrupt-agent', agentId, clearQueue: true });

    expect((hub as any).activeInputRequests.has(agentId)).toBe(true);

    spy.mockRestore();
    hub.cancelInputRequests(agentId, 'cleanup');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    hub.unregisterAgent(agentId);
  });
});