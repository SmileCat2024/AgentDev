import { describe, expect, it } from 'vitest';
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
});
