import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ViewerWorker } from '../src/viewer-worker.js';

/**
 * 模板装载点（mount）协议测试。
 *
 * 背景（2026-08-22 架构收敛）：模板 URL 曾在三层各自猜测包磁盘布局
 * （agent.ts 生成端 / viewer-worker 服务端 / 前端 SYSTEM_TEMPLATE_MAP 兜底），
 * 四包拆分后猜测全部失效导致模板 404 并静默降级 JSON。mount 协议改为
 * "注册传事实 + 不透明 mountId + 字节镜像服务"，本测试锁定其核心契约：
 *
 * 1. 注册载荷（mounts + entries）→ /tpl/{mountId}/{rel} URL → 文件字节可达
 * 2. 路径穿越防护（rel 不得逃出 mount root）
 * 3. mount 注册表引用计数（agent 断开后回收，共享 mount 不误删）
 * 4. 协议不混版：非 mount 载荷字段（旧版 URL 映射）被完全无视
 * 5. 注册时验证：磁盘缺失的 entry 被剔除并告警，其余条目正常服务
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-tpl-mount-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-tpl-mount-${process.pid}-${Date.now()}.sock`;
}

function mountIdForRoot(root: string): string {
  return createHash('sha1').update(root.split('\\').join('/').toLowerCase()).digest('hex').slice(0, 12);
}

/** handleTplAsset 内部走异步 readFile（Windows 线程池），断言前需等待 I/O 轮询完成 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** 模拟 HTTP response，捕获 writeHead 状态码/头与 end 返回体 */
function createMockRes() {
  let statusCode = 0;
  let headers: Record<string, string | string[]> = {};
  let body: Buffer | string = '';
  return {
    writeHead(code: number, h?: Record<string, string | string[]>) { statusCode = code; headers = h || {}; },
    end(data?: Buffer | string) { if (data !== undefined) body = data; },
    getStatusCode() { return statusCode; },
    getHeaders() { return headers; },
    getBody() { return body; },
    getText() { return typeof body === 'string' ? body : body.toString('utf-8'); },
    getJson() { return JSON.parse(typeof body === 'string' ? body : body.toString('utf-8')); },
  };
}

describe('ViewerWorker template mount protocol', () => {
  const tmpRoot = join(tmpdir(), `agentdev-tpl-test-${process.pid}-${Date.now()}`);
  const pkgADir = join(tmpRoot, 'pkg-a');
  const pkgBDir = join(tmpRoot, 'pkg-b');
  let worker: ViewerWorker;

  beforeAll(() => {
    mkdirSync(join(pkgADir, 'dist', 'features', 'demo', 'templates'), { recursive: true });
    mkdirSync(join(pkgBDir, 'dist', 'features', 'demo', 'templates'), { recursive: true });
    writeFileSync(join(pkgADir, 'dist', 'features', 'demo', 'templates', 'read.render.js'), '// pkg-a read template');
    writeFileSync(join(pkgADir, 'dist', 'chunk-shared.js'), '// pkg-a shared chunk');
    writeFileSync(join(pkgBDir, 'dist', 'features', 'demo', 'templates', 'read.render.js'), '// pkg-b read template');

    worker = new ViewerWorker(0, false, getTestUdsPath());
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('register → /tpl/ URL → asset bytes round-trip (per-mount isolation)', async () => {
    const agentId = 'tpl-agent-1';
    worker.handleRegisterAgent({
      agentId,
      name: 'Tpl Agent 1',
      templateMounts: [pkgADir, pkgBDir],
      templateEntries: {
        'read': { mount: 0, rel: 'dist/features/demo/templates/read.render.js' },
        'read-pkg-b': { mount: 1, rel: 'dist/features/demo/templates/read.render.js' },
      },
    });

    // handleGetFeatureTemplates 生成的 URL 必须命中各自 mount 的字节
    const res = createMockRes();
    const req = { url: `/api/templates/feature?agentId=${agentId}` } as any;
    worker.handleGetFeatureTemplates(req, res as any, new URLSearchParams(`agentId=${agentId}`));
    expect(res.getStatusCode()).toBe(200);
    const map = res.getJson();
    expect(map['read']).toBe(`/tpl/${mountIdForRoot(pkgADir)}/dist/features/demo/templates/read.render.js`);
    expect(map['read-pkg-b']).toBe(`/tpl/${mountIdForRoot(pkgBDir)}/dist/features/demo/templates/read.render.js`);

    // 两个 URL 服务到不同字节（mount 隔离，不串包）
    const resA = createMockRes();
    worker.handleTplAsset({} as any, resA as any, map['read']);
    await flushAsync();
    expect(resA.getStatusCode()).toBe(200);
    expect(resA.getText()).toBe('// pkg-a read template');

    const resB = createMockRes();
    worker.handleTplAsset({} as any, resB as any, map['read-pkg-b']);
    await flushAsync();
    expect(resB.getStatusCode()).toBe(200);
    expect(resB.getText()).toBe('// pkg-b read template');
  });

  it('serves shared chunks inside mount root (chunk relative import reachability)', async () => {
    // 模板内部 import ../../../chunk-shared.js → 浏览器解析为 /tpl/{mountId}/dist/chunk-shared.js
    const res = createMockRes();
    worker.handleTplAsset({} as any, res as any, `/tpl/${mountIdForRoot(pkgADir)}/dist/chunk-shared.js`);
    await flushAsync();
    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeaders()['Cache-Control']).toBe('no-cache');
    expect(res.getText()).toBe('// pkg-a shared chunk');
  });

  it('rejects path traversal escaping mount root with 403', async () => {
    const res = createMockRes();
    worker.handleTplAsset(
      {} as any,
      res as any,
      `/tpl/${mountIdForRoot(pkgADir)}/dist/../../secrets.js`
    );
    await flushAsync();
    expect(res.getStatusCode()).toBe(403);
  });

  it('returns 404 for unregistered mountId', async () => {
    const res = createMockRes();
    worker.handleTplAsset({} as any, res as any, `/tpl/${'0'.repeat(12)}/dist/x.js`);
    await flushAsync();
    expect(res.getStatusCode()).toBe(404);
  });

  it('keeps shared mount alive while any agent holds it, reclaims after all disconnect', async () => {
    const agent2 = 'tpl-agent-2';
    worker.handleRegisterAgent({
      agentId: agent2,
      name: 'Tpl Agent 2',
      templateMounts: [pkgADir],
      templateEntries: { 'read': { mount: 0, rel: 'dist/features/demo/templates/read.render.js' } },
    });

    // agent-1（共享 pkgA）断开：mount 仍被 agent-2 持有，资产仍可服务
    worker.handleUnregisterAgent({ agentId: 'tpl-agent-1' });
    const resHold = createMockRes();
    worker.handleTplAsset({} as any, resHold as any, `/tpl/${mountIdForRoot(pkgADir)}/dist/chunk-shared.js`);
    await flushAsync();
    expect(resHold.getStatusCode()).toBe(200);

    // 最后持有者断开：mount 回收，资产 404
    worker.handleUnregisterAgent({ agentId: agent2 });
    const resGone = createMockRes();
    worker.handleTplAsset({} as any, resGone as any, `/tpl/${mountIdForRoot(pkgADir)}/dist/chunk-shared.js`);
    await flushAsync();
    expect(resGone.getStatusCode()).toBe(404);
  });

  it('ignores non-mount payload fields entirely (no legacy protocol handling)', async () => {
    const agentId = 'tpl-legacy-agent';
    worker.handleRegisterAgent({
      agentId,
      name: 'Legacy Agent',
      featureTemplates: { 'read': '/template/agentdev/demo/read.render.js' },
    });

    // 旧版字段（URL 映射）不被读取：注册正常、模板为空，无任何兼容分支
    const res = createMockRes();
    worker.handleGetFeatureTemplates({} as any, res as any, new URLSearchParams(`agentId=${agentId}`));
    expect(res.getStatusCode()).toBe(200);
    expect(res.getText()).toBe('{}');
  });

  it('drops entries whose files are missing at registration (warn, rest survive)', async () => {
    const agentId = 'tpl-missing-agent';
    worker.handleRegisterAgent({
      agentId,
      name: 'Missing Entry Agent',
      templateMounts: [pkgBDir],
      templateEntries: {
        'read': { mount: 0, rel: 'dist/features/demo/templates/read.render.js' },
        'ghost': { mount: 0, rel: 'dist/features/demo/templates/ghost.render.js' },
      },
    });

    const res = createMockRes();
    worker.handleGetFeatureTemplates({} as any, res as any, new URLSearchParams(`agentId=${agentId}`));
    const map = res.getJson();
    expect(map['read']).toBeTruthy();
    expect(map['ghost']).toBeUndefined();
  });
});
