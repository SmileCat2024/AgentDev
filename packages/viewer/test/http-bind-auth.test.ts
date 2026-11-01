/**
 * HTTP 面非回环绑定与 Bearer 强制（ADR-0037 M5）
 *
 * 契约：
 *   - 默认 / 回环 bind（127.0.0.1 / ::1 / localhost）：不校验 Authorization，
 *     行为与历史完全一致（回环模式行为不变是 M2 既定 sequencing 的一半）。
 *   - 非回环 bind（如 0.0.0.0，容器部署经 AGENTDEV_VIEWER_HTTP_BIND 开启）：
 *     全端点强制 `Authorization: Bearer <PROTOCLAW_INTERNAL_TOKEN>`，
 *     缺失或错误一律 401。
 *   - 非回环 bind 且未设 token：构造即抛错（与 AGENTDEV_VIEWER_ADDR 的
 *     TCP 通道同一信任模型）。
 *
 * runtime 侧携带 token 的行为在 core/test/viewer-http-origin.test.ts 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';

const ENV_KEYS = ['AGENTDEV_VIEWER_HTTP_BIND', 'PROTOCLAW_INTERNAL_TOKEN', 'AGENTDEV_VIEWER_ADDR'] as const;

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-http-bind-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
  return `/tmp/agentdev-http-bind-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`;
}

function getTestPort(): number {
  return 18000 + Math.floor(Math.random() * 2000);
}

const workers: ViewerWorker[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(() => stopAll());

async function stopAll(): Promise<void> {
  for (const w of workers) {
    await w.stop().catch(() => {});
  }
  workers.length = 0;
}

describe('ViewerWorker HTTP bind and Bearer enforcement', () => {
  it('loopback bind (default) serves API without Authorization header', async () => {
    const port = getTestPort();
    const worker = new ViewerWorker(port, false, getTestUdsPath());
    workers.push(worker);
    await worker.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    expect(res.status).toBe(200);
  });

  it('explicit loopback bind (127.0.0.1) keeps behavior unchanged', async () => {
    process.env.AGENTDEV_VIEWER_HTTP_BIND = '127.0.0.1';
    const port = getTestPort();
    const worker = new ViewerWorker(port, false, getTestUdsPath());
    workers.push(worker);
    await worker.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    expect(res.status).toBe(200);
  });

  it('non-loopback bind rejects missing, wrong, and accepts correct Bearer token', async () => {
    process.env.AGENTDEV_VIEWER_HTTP_BIND = '0.0.0.0';
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'test-internal-token';
    const port = getTestPort();
    const worker = new ViewerWorker(port, false, getTestUdsPath());
    workers.push(worker);
    await worker.start();

    const base = `http://127.0.0.1:${port}`;

    const noAuth = await fetch(`${base}/api/agents`);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await fetch(`${base}/api/agents`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(wrongAuth.status).toBe(401);

    const okAuth = await fetch(`${base}/api/agents`, {
      headers: { Authorization: 'Bearer test-internal-token' },
    });
    expect(okAuth.status).toBe(200);
  });

  it('non-loopback bind enforces Bearer on all endpoints, not only /api', async () => {
    process.env.AGENTDEV_VIEWER_HTTP_BIND = '0.0.0.0';
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'test-internal-token';
    const port = getTestPort();
    const worker = new ViewerWorker(port, false, getTestUdsPath());
    workers.push(worker);
    await worker.start();

    const base = `http://127.0.0.1:${port}`;
    // 主页与 /mcp 同属 HTTP 面，非回环时一并拦截（internal transport 整面鉴权）
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/mcp`)).status).toBe(401);
  });

  it('non-loopback bind without PROTOCLAW_INTERNAL_TOKEN throws at construction', () => {
    process.env.AGENTDEV_VIEWER_HTTP_BIND = '0.0.0.0';
    expect(() => new ViewerWorker(getTestPort(), false, getTestUdsPath())).toThrow(
      /PROTOCLAW_INTERNAL_TOKEN is required/,
    );
  });
});
