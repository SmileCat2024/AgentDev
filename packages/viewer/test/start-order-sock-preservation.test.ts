/**
 * ViewerWorker 启动顺序回归测试（sock 抢占事故）
 *
 * 历史 bug：start() 先 startUDSServer()（unlink 路径上的现有 sock 并 bind
 * 自己的）再 HTTP listen。当 HTTP 端口被占用（误启动的第二个实例）时进程
 * 失败退出且无清理，导致：
 *   1. 既有实例的 sock 文件被删除（路径失联，新连接方 ENOENT）
 *   2. 或路径被替换为失败实例 bind 的死 sock（有文件无 listener，ECONNREFUSED）
 * 一次误启动即令全部 runtime 永久失联，且系统无自愈路径。
 *
 * 契约：
 *   - start() 必须 HTTP listen 成功后才接管 UDS 路径
 *   - start() resolve 后 UDS listener 立即可连（无需外部轮询等待）
 */
import { describe, it, expect, afterAll } from 'vitest';
import { connect } from 'net';
import { existsSync } from 'fs';
import { ViewerWorker } from '../src/viewer-worker.js';

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-start-order-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-start-order-${process.pid}-${Date.now()}.sock`;
}

function getTestPort(): number {
  return 18000 + Math.floor(Math.random() * 2000);
}

/** 尝试连接 UDS 路径，返回是否成功（超时视为失败） */
function canConnect(udsPath: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(udsPath);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

const workers: ViewerWorker[] = [];

async function stopAll(): Promise<void> {
  for (const w of workers) {
    await w.stop().catch(() => {});
  }
  workers.length = 0;
}

afterAll(() => stopAll());

describe('ViewerWorker start order (sock path preservation)', () => {
  it('must not disturb an existing UDS path when the HTTP port is already taken', async () => {
    const udsPath = getTestUdsPath();
    const port = getTestPort();

    // 既有实例：正常启动并验证 UDS 可达
    const primary = new ViewerWorker(port, false, udsPath);
    workers.push(primary);
    await primary.start();
    if (process.platform !== 'win32') {
      expect(existsSync(udsPath)).toBe(true);
    }
    expect(await canConnect(udsPath)).toBe(true);

    // 第二个实例：同端口、同 UDS 路径——模拟误启动的双实例
    const second = new ViewerWorker(port, false, udsPath);
    workers.push(second);
    await expect(second.start()).rejects.toThrow(/端口|EADDRINUSE/);

    // 失败实例的 stop() 同样不得删除路径上属于他人的 sock 文件
    // （stop 的清理曾无条件 unlink 路径文件，把这一步变成了破坏点）
    await second.stop();

    // 核心回归断言：既有实例的 sock 既未被删除、listener 也仍存活
    if (process.platform !== 'win32') {
      expect(existsSync(udsPath)).toBe(true);
    }
    expect(await canConnect(udsPath)).toBe(true);
  });

  it('UDS listener is ready as soon as start() resolves', async () => {
    const udsPath = getTestUdsPath();
    const worker = new ViewerWorker(getTestPort(), false, udsPath);
    workers.push(worker);
    await worker.start();

    // start() resolve 即代表 UDS listen 完成，连接不允许有任何竞态窗口
    expect(await canConnect(udsPath)).toBe(true);
  });
});
