import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';

/**
 * 资源读取协议测试（ADR-0038）：/res/{agentId}/{rootId}/{rel} 资产服务。
 *
 * 契约声明（worker 侧，runtime 侧 handler 由 core 的 resource-serve 测试覆盖）：
 * 1. 注册载荷（rootCount + entries）→ /api/templates/feature 下发
 *    模板名 → /res/{agentId}/{rootId}/{rel} 映射；
 * 2. /res/ 请求经 host-request 帧回源：帧携带
 *    { requestType: 'resource.fetch', rootId, rel }（拍平：requestType 为
 *    类型化分发保留键），
 *    runtime 的 {ok, data(base64)} 响应解码为字节返回，MIME 按 rel 扩展名，
 *    Cache-Control: no-cache；
 * 3. 失败映射：forbidden → 403；其余 runtime 结果码 → 404（前端回退
 *    默认渲染为既有降级）；
 * 4. 未注册 agent / rootId 越界 / runtime 断连 → 404，且越界 rootId 不产生
 *    回源帧（不骚扰 runtime）；
 * 5. 注册校验：rootId 越界的 entry 被剔除；unregister 清空载荷。
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-res-fetch-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-res-fetch-${process.pid}-${Date.now()}.sock`;
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
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

interface CapturedFrame {
  requestId: string;
  agentId: string;
  payload: any;
}

/**
 * 伪 runtime 连接：捕获 host-request 帧，并按 frameHandler 决定回什么。
 * frameHandler 返回 undefined 表示不响应（用于超时用例）。
 */
function attachFakeRuntime(worker: ViewerWorker, clientId: string, frameHandler: (frame: CapturedFrame) => unknown): CapturedFrame[] {
  const captured: CapturedFrame[] = [];
  const fakeSocket = {
    write: (line: string) => {
      const msg = JSON.parse(line);
      if (msg.type !== 'host-request') return;
      const frame: CapturedFrame = { requestId: msg.requestId, agentId: msg.agentId, payload: msg.payload };
      captured.push(frame);
      const response = frameHandler(frame);
      if (response !== undefined) {
        // 经与真实 runtime 相同的回传路径（host-response 帧分发）
        (worker as any).handleUDSMessage(
          { type: 'host-response', requestId: frame.requestId, result: response },
          fakeSocket,
          clientId,
        );
      }
    },
  };
  (worker as any).udsClients.set(clientId, fakeSocket);
  return captured;
}

describe('ViewerWorker resource fetch protocol (/res/)', () => {
  let worker: ViewerWorker;
  const agentId = 'res-agent-1';

  /** runtime 侧真实现的行为按 core 测试单独覆盖；此处按协议回固定内容 */
  const runtimeFiles: Record<string, string> = {
    '0:dist/features/demo/templates/read.render.js': '// pkg-a read template',
    '1:dist/features/demo/templates/read.render.js': '// pkg-b read template',
    '0:dist/chunk-shared.js': '// pkg-a shared chunk',
  };

  function fakeRuntimeHandler(frame: CapturedFrame): unknown {
    const { rootId, rel } = frame.payload ?? {};
    const key = `${rootId}:${rel}`;
    if (key === '0:dist/escape.js') return { ok: false, code: 'forbidden' };
    if (key === '0:dist/ghost.js') return { ok: false, code: 'not_found' };
    const content = runtimeFiles[key];
    if (content === undefined) return { ok: false, code: 'not_found' };
    return { ok: true, data: Buffer.from(content, 'utf-8').toString('base64') };
  }

  let captured: CapturedFrame[];

  beforeAll(() => {
    worker = new ViewerWorker(0, false, getTestUdsPath());
    worker.handleRegisterAgent(
      {
        agentId,
        name: 'Res Agent 1',
        resourceRootCount: 2,
        templateEntries: {
          'read': { root: 0, rel: 'dist/features/demo/templates/read.render.js' },
          'read-pkg-b': { root: 1, rel: 'dist/features/demo/templates/read.render.js' },
        },
      },
      'c1',
    );
    captured = attachFakeRuntime(worker, 'c1', fakeRuntimeHandler);
  });

  afterAll(() => {
    (worker as any).udsClients.delete('c1');
  });

  it('register → /res/ URL map → bytes round-trip through host-request', async () => {
    const res = createMockRes();
    worker.handleGetFeatureTemplates({} as any, res as any, new URLSearchParams(`agentId=${agentId}`));
    expect(res.getStatusCode()).toBe(200);
    const map = res.getJson();
    expect(map['read']).toBe(`/res/${agentId}/0/dist/features/demo/templates/read.render.js`);
    expect(map['read-pkg-b']).toBe(`/res/${agentId}/1/dist/features/demo/templates/read.render.js`);

    const resA = createMockRes();
    worker.handleResAsset({} as any, resA as any, map['read']);
    await flushAsync();
    expect(resA.getStatusCode()).toBe(200);
    expect(resA.getText()).toBe('// pkg-a read template');
    expect(resA.getHeaders()['Content-Type']).toBe('application/javascript; charset=utf-8');
    expect(resA.getHeaders()['Cache-Control']).toBe('no-cache');

    // 回源帧契约：拍平载荷（requestType 为类型化分发保留键，其余字段即
    // handler 域数据），agentId 寻址正确
    expect(captured).toHaveLength(1);
    expect(captured[0].agentId).toBe(agentId);
    expect(captured[0].payload).toEqual({
      requestType: 'resource.fetch',
      rootId: 0,
      rel: 'dist/features/demo/templates/read.render.js',
    });
  });

  it('routes the same rel to different roots without cross-talk', async () => {
    const resB = createMockRes();
    worker.handleResAsset({} as any, resB as any, `/res/${agentId}/1/dist/features/demo/templates/read.render.js`);
    await flushAsync();
    expect(resB.getStatusCode()).toBe(200);
    expect(resB.getText()).toBe('// pkg-b read template');
  });

  it('serves shared chunks inside the root (relative import reachability)', async () => {
    const res = createMockRes();
    worker.handleResAsset({} as any, res as any, `/res/${agentId}/0/dist/chunk-shared.js`);
    await flushAsync();
    expect(res.getStatusCode()).toBe(200);
    expect(res.getText()).toBe('// pkg-a shared chunk');
  });

  /**
   * 畸形路径在 viewer 层直接拒绝，不回源。断言点是「没有向 runtime 发帧」：
   * 仅断言 404 无法区分修复前后——回源后 runtime 同样会返回 not_found/forbidden，
   * 状态码一致，只有帧数量能暴露边界是否真的前置。
   *
   * 三个拒绝口径：百分号编码非法（decodeURIComponent 抛错）、含 NUL、
   * 含反斜杠（win32 下是路径分隔符，运行在 win32 的 runtime 会把它当穿越）。
   */
  it('rejects malformed resource paths at the viewer without consulting the runtime', async () => {
    const cases = [
      `/res/${agentId}/0/%zz/etc/passwd`,        // 非法百分号编码
      `/res/${agentId}/0/dist%00chunk.js`,       // NUL
      `/res/${agentId}/0/..%5c..%5cetc%5cpasswd`, // 编码后的反斜杠
    ];
    for (const url of cases) {
      const before = captured.length;
      const res = createMockRes();
      worker.handleResAsset({} as any, res as any, url);
      await flushAsync();
      expect(res.getStatusCode(), url).toBe(404);
      expect(captured.length, url).toBe(before);
    }
  });

  it('maps forbidden to 403 and other runtime codes to 404', async () => {
    const res403 = createMockRes();
    worker.handleResAsset({} as any, res403 as any, `/res/${agentId}/0/dist/escape.js`);
    await flushAsync();
    expect(res403.getStatusCode()).toBe(403);

    const res404 = createMockRes();
    worker.handleResAsset({} as any, res404 as any, `/res/${agentId}/0/dist/ghost.js`);
    await flushAsync();
    expect(res404.getStatusCode()).toBe(404);
  });

  it('returns 404 for out-of-range rootId without sending a frame to the runtime', async () => {
    const before = captured.length;
    const res = createMockRes();
    worker.handleResAsset({} as any, res as any, `/res/${agentId}/5/dist/x.js`);
    await flushAsync();
    expect(res.getStatusCode()).toBe(404);
    expect(captured.length).toBe(before);
  });

  it('returns 404 for unknown agent and for disconnected runtime', async () => {
    const resUnknown = createMockRes();
    worker.handleResAsset({} as any, resUnknown as any, `/res/nobody/0/dist/x.js`);
    await flushAsync();
    expect(resUnknown.getStatusCode()).toBe(404);

    // 注册但 runtime 连接不在：404（前端回退默认渲染）
    (worker as any).udsClients.delete('c1');
    const resDisc = createMockRes();
    worker.handleResAsset({} as any, resDisc as any, `/res/${agentId}/0/dist/chunk-shared.js`);
    await flushAsync();
    expect(resDisc.getStatusCode()).toBe(404);
    (worker as any).udsClients.set('c1', { write: () => { captured.push({ requestId: 'noop', agentId, payload: null }); } });
  });

  it('returns 404 when the runtime does not respond in time', async () => {
    const prevTimeout = process.env.AGENTDEV_HOST_REQUEST_TIMEOUT_MS;
    process.env.AGENTDEV_HOST_REQUEST_TIMEOUT_MS = '1';
    // 换成不响应的伪 runtime
    (worker as any).udsClients.set('c1', { write: () => { /* 不响应 */ } });
    try {
      const res = createMockRes();
      worker.handleResAsset({} as any, res as any, `/res/${agentId}/0/dist/chunk-shared.js`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(res.getStatusCode()).toBe(404);
    } finally {
      process.env.AGENTDEV_HOST_REQUEST_TIMEOUT_MS = prevTimeout;
    }
  });

  it('drops out-of-range entries at registration and clears payloads on unregister', async () => {
    const agentId2 = 'res-agent-2';
    worker.handleRegisterAgent(
      {
        agentId: agentId2,
        name: 'Res Agent 2',
        resourceRootCount: 1,
        templateEntries: {
          'read': { root: 0, rel: 'dist/features/demo/templates/read.render.js' },
          'bad-root': { root: 3, rel: 'dist/features/demo/templates/read.render.js' },
        },
      },
      'c2',
    );

    const res = createMockRes();
    worker.handleGetFeatureTemplates({} as any, res as any, new URLSearchParams(`agentId=${agentId2}`));
    const map = res.getJson();
    expect(map['read']).toBeTruthy();
    expect(map['bad-root']).toBeUndefined();

    // 旧版 mount 载荷字段被完全无视（协议不混版）
    worker.handleRegisterAgent(
      { agentId: 'res-legacy', name: 'Legacy', templateMounts: ['/tmp/anything'], templateEntries: { 'read': { mount: 0, rel: 'x.js' } } },
      'c3',
    );
    const resLegacy = createMockRes();
    worker.handleGetFeatureTemplates({} as any, resLegacy as any, new URLSearchParams('agentId=res-legacy'));
    expect(resLegacy.getText()).toBe('{}');

    // unregister 清空：映射为空、URL 404
    worker.handleUnregisterAgent({ agentId: agentId2 });
    const resGone = createMockRes();
    worker.handleResAsset({} as any, resGone as any, `/res/${agentId2}/0/dist/features/demo/templates/read.render.js`);
    await flushAsync();
    expect(resGone.getStatusCode()).toBe(404);
  });
});
