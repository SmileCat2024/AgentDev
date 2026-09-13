/**
 * DebugHub 托管传输回归测试（sock 抢占事故）
 *
 * 历史 bug：DebugHub 连接 ViewerWorker 失败时会无条件自动 spawn 一个新
 * ViewerWorker。在托管环境（宿主通过 AGENTDEV_UDS_PATH 显式指定 UDS 路径，
 * 如 Claw spawn 的 runtime）中，拉起的 worker 注定 HTTP 端口冲突，且它
 * 在失败退出前还会 unlink 并抢占宿主的 sock 路径——把宿主与全部 runtime
 * 的 IPC 通道一起拖死，演变为"一次连接抖动 → 全员失联"的死亡螺旋。
 *
 * 契约：AGENTDEV_UDS_PATH 显式设置时，连接失败必须直接上抛原始连接错误，
 * 不得尝试自动拉起 ViewerWorker。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DebugHub } from '../src/core/debug-hub.js';

function getDeadUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-managed-transport-dead-${process.pid}-${Date.now()}`;
  }
  // pid+timestamp 保证唯一：路径上既无文件也无 listener，connect 必然失败
  return `/tmp/agentdev-managed-transport-dead-${process.pid}-${Date.now()}.sock`;
}

describe('DebugHub managed transport (AGENTDEV_UDS_PATH set)', () => {
  const hub = DebugHub.getInstance();
  let originalUdsPath: string | undefined;

  afterEach(() => {
    hub.stop();
    if (originalUdsPath === undefined) {
      delete process.env.AGENTDEV_UDS_PATH;
    } else {
      process.env.AGENTDEV_UDS_PATH = originalUdsPath;
    }
    vi.restoreAllMocks();
  });

  it('rethrows the connect error without auto-spawning a ViewerWorker', async () => {
    hub.stop();
    originalUdsPath = process.env.AGENTDEV_UDS_PATH;

    const deadPath = getDeadUdsPath();
    process.env.AGENTDEV_UDS_PATH = deadPath;
    (hub as any).udsPath = deadPath;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(hub.start(0, false)).rejects.toThrow(/连接 ViewerWorker 失败/);

    // 自动拉起路径独有的日志不得出现（一旦出现说明 spawn 分支被执行）
    const allLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .map((call) => call.map(String).join(' '))
      .join('\n');
    expect(allLogs).not.toContain('正在自动启动');
    expect(allLogs).not.toContain('无法启动 ViewerWorker');
  });
});
