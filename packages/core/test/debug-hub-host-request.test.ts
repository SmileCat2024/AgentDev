/**
 * DebugHub host-request 分发契约（host-request/host-response 帧，ADR-0037 开放点通道化）：
 *
 * - 注册回调收到透传 payload 与 agentId，返回值经 host-response 帧回传；
 * - 回调抛错必须回 error（不得静默丢弃——ViewerWorker 侧 HTTP 调用方在等）；
 * - 未注册回调同样必须回显式 error；
 * - 注销函数（返回值）停止分发。
 * 预期依据：viewer-worker host-request 端点以 requestId 关联等待响应，
 * 任何丢弃路径都会让调用方挂到超时，因此"必达响应"是契约本体。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DebugHub } from '../src/core/debug-hub.js';

describe('DebugHub host-request dispatch', () => {
  const hub = DebugHub.getInstance();

  afterEach(() => {
    hub.stop();
    (hub as any).globalHostRequestHandler = undefined;
    (hub as any).hostRequestHandlers.clear();
    vi.restoreAllMocks();
  });

  async function dispatch(frame: Record<string, unknown>) {
    (hub as any).handleWorkerMessage(frame);
    // 分发经 Promise.resolve().then() 异步结算，等两个微任务 tick
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('passes payload through and returns the handler result as host-response', async () => {
    const sendSpy = vi.spyOn(hub as any, 'sendToWorker').mockImplementation(() => true);
    const seen: Array<{ payload: unknown; agentId: string }> = [];
    hub.setHostRequestHandler('agent-a', (payload, agentId) => {
      seen.push({ payload, agentId });
      return { ok: true, echoed: payload };
    });

    await dispatch({ type: 'host-request', requestId: 'req-1', agentId: 'agent-a', payload: { kind: 'probe', n: 7 } });

    expect(seen).toEqual([{ payload: { kind: 'probe', n: 7 }, agentId: 'agent-a' }]);
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'host-response',
      requestId: 'req-1',
      result: { ok: true, echoed: { kind: 'probe', n: 7 } },
    });
  });

  it('responds with an error when the handler throws', async () => {
    const sendSpy = vi.spyOn(hub as any, 'sendToWorker').mockImplementation(() => true);
    hub.setHostRequestHandler('agent-b', () => {
      throw new Error('feature exploded');
    });

    await dispatch({ type: 'host-request', requestId: 'req-2', agentId: 'agent-b', payload: null });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const reply = sendSpy.mock.calls[0][0];
    expect(reply.type).toBe('host-response');
    expect(reply.requestId).toBe('req-2');
    expect(reply.error).toContain('feature exploded');
    expect(reply.result).toBeUndefined();
  });

  it('responds with an explicit error when no handler is registered', async () => {
    const sendSpy = vi.spyOn(hub as any, 'sendToWorker').mockImplementation(() => true);

    await dispatch({ type: 'host-request', requestId: 'req-3', agentId: 'nobody', payload: null });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      type: 'host-response',
      requestId: 'req-3',
      error: expect.stringContaining('No host request handler registered'),
    });
  });

  it('stops dispatching after the unregister function runs', async () => {
    const sendSpy = vi.spyOn(hub as any, 'sendToWorker').mockImplementation(() => true);
    let calls = 0;
    const unregister = hub.setHostRequestHandler('agent-c', () => { calls += 1; return null; });

    await dispatch({ type: 'host-request', requestId: 'req-4', agentId: 'agent-c', payload: null });
    unregister();
    await dispatch({ type: 'host-request', requestId: 'req-5', agentId: 'agent-c', payload: null });

    expect(calls).toBe(1);
    // 注销后的请求走"未注册"路径：仍必达 error 响应
    expect(sendSpy.mock.calls[1][0]).toMatchObject({ type: 'host-response', requestId: 'req-5' });
  });
});
