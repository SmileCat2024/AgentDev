/**
 * DebugHub queued-input-available 分发契约（空闲消费加速信号，ADR-0047 后补充）。
 *
 * 背景与承诺：ADR-0047 关闭 lease 直答后，durable command 只能经 claim/ack
 * 协议消费；空闲态消费原是消费方 1s 轮询。ViewerWorker 在输入入队落盘成功
 * 后下发 queued-input-available 帧——纯加速信号，不携带队列数据；收到方
 * 只应触发一次既有的 claim/dequeue 尝试。本文件只测 DebugHub 侧分发：
 * - per-agent 回调按 msg.agentId 精确触发；未注册 per-agent 时落全局 fallback；
 * - per-agent 与全局并存时 per-agent 优先；
 * - 未注册任何回调时静默忽略（消费方轮询兜底，帧不是错误）；
 * - 回调抛异常不外溢（信号处理失败不得影响 worker 连接）；
 * - 注册函数返回注销句柄，注销后不再触发。
 * 不测：通知何时发出（viewer-worker 侧契约）、消费协议本身（passive loop 侧契约）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DebugHub } from '../src/core/debug-hub.js';

describe('DebugHub queued-input-available dispatch', () => {
  const hub = DebugHub.getInstance();

  afterEach(() => {
    hub.setQueuedInputAvailableHandler(undefined as any, undefined);
    (hub as any).queuedInputAvailableHandlers.clear();
  });

  function dispatch(agentId: string): void {
    (hub as any).handleWorkerMessage({ type: 'queued-input-available', agentId });
  }

  it('invokes the per-agent handler with the frame agentId', () => {
    const seen: string[] = [];
    hub.setQueuedInputAvailableHandler('agent-a', (agentId) => { seen.push(agentId); });

    dispatch('agent-a');

    expect(seen).toEqual(['agent-a']);
  });

  it('does not invoke the per-agent handler for a different agentId', () => {
    const seen: string[] = [];
    hub.setQueuedInputAvailableHandler('agent-a', (agentId) => { seen.push(agentId); });

    dispatch('agent-b');

    expect(seen).toEqual([]);
  });

  it('falls back to the global handler when no per-agent handler matches', () => {
    const seen: string[] = [];
    hub.setQueuedInputAvailableHandler((agentId) => { seen.push(agentId); });

    dispatch('agent-any');

    expect(seen).toEqual(['agent-any']);
  });

  it('prefers the per-agent handler over the global one', () => {
    const seen: string[] = [];
    hub.setQueuedInputAvailableHandler('agent-a', () => { seen.push('per-agent'); });
    hub.setQueuedInputAvailableHandler(() => { seen.push('global'); });

    dispatch('agent-a');

    expect(seen).toEqual(['per-agent']);
  });

  it('ignores the frame silently when no handler is registered', () => {
    expect(() => dispatch('agent-nobody')).not.toThrow();
  });

  it('swallows handler rejections (signal handling must not break the connection)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const followUp: string[] = [];
    // 与 stop-agent 分发同构：rejection 经 Promise.resolve().catch() 吞掉
    hub.setQueuedInputAvailableHandler('agent-a', () => Promise.reject(new Error('handler boom')));
    hub.setQueuedInputAvailableHandler((agentId) => { followUp.push(agentId); });

    expect(() => dispatch('agent-a')).not.toThrow();
    // 微任务排空后 rejection 已被 catch 记录
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalled();

    // rejection 被吞掉后，后续帧的分发不受影响（agent-z 无 per-agent → 全局）
    dispatch('agent-z');
    expect(followUp).toEqual(['agent-z']);
  });

  it('returns an unregister function that stops further invocations', () => {
    const seen: string[] = [];
    const unregister = hub.setQueuedInputAvailableHandler('agent-a', (agentId) => { seen.push(agentId); });

    dispatch('agent-a');
    unregister();
    dispatch('agent-a');

    expect(seen).toEqual(['agent-a']);
  });
});
