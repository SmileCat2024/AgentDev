import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// connectToWorker 的每次尝试都立即失败（error 事件），驱动
// scheduleReconnect → 失败 → 再 scheduleReconnect 的完整循环。
vi.mock('net', () => ({
  connect: vi.fn(() => {
    const socket = new EventEmitter() as any;
    socket.setEncoding = () => {};
    queueMicrotask(() => socket.emit('error', new Error('mock connect failure')));
    return socket;
  }),
}));

import * as net from 'net';
import { DebugHub } from '../../src/core/debug-hub.js';

const connectMock = vi.mocked(net.connect);

describe('DebugHub reconnect scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // DebugHub 是单例，重置跨测试残留的重连计数
    (DebugHub.getInstance() as any).reconnectAttempts = 0;
    (DebugHub.getInstance() as any).stopped = false;
    connectMock.mockClear();
  });

  afterEach(() => {
    const hub = DebugHub.getInstance();
    (hub as any).stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps retrying beyond the former 10-attempt cap (30s-capped backoff)', async () => {
    const hub = DebugHub.getInstance();
    (hub as any).scheduleReconnect();

    // 2s 起指数退避、30s 封顶：推进 400s 虚拟时间足够覆盖远超 10 次的
    // 重试循环。每个周期：timer → connectToWorker → error → 再排定。
    await vi.advanceTimersByTimeAsync(400_000);

    const attempts = (hub as any).reconnectAttempts as number;
    expect(attempts).toBeGreaterThanOrEqual(12);
    expect(connectMock.mock.calls.length).toBeGreaterThanOrEqual(12);
  });

  it('stops scheduling once stopped', async () => {
    const hub = DebugHub.getInstance();
    (hub as any).scheduleReconnect();
    (hub as any).stop();

    await vi.advanceTimersByTimeAsync(120_000);

    const attempts = (hub as any).reconnectAttempts as number;
    expect(attempts).toBe(1);
    expect(connectMock).not.toHaveBeenCalled();
  });
});
