/**
 * 轮次挂起语义（ADR-0019 阶段 1 + ADR-0031 薄接入）shell 侧测试
 *
 * 覆盖：
 * - ShellFeature CallStart 申报：经实例 BackgroundAccess（实例唯一注册 key）
 *   挂接 pending-work provider；access 未创建（无 bash 装配）时不注册；
 *   running 任务映射 {source:'shell', id, summary:command}
 * - 任务归属盖戳：登记时经归属 access 捕获，快照暴露；多实例（多会话）
 *   共享登记表时各任务归属随各自 access，不被收养改写（修复 5）
 * - 多会话不串：pending 申报按归属实例隔离、待命意图按实例隔离
 * - 通知投递 body 携带会话；未声明时不携带（单 runtime 现状兼容）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundAccess } from '@agentdevjs/core';
import type { PendingWakeup } from '@agentdevjs/core';
import { BgRegistry } from '../src/bg-core.js';
import type { BgRegisterOptions } from '../src/bg-core.js';
import { ShellFeature, findGitBashPath } from '../src/index.js';

const workdir = mkdtempSync(join(tmpdir(), 'agentdev-shell-susp-'));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn(() => true);
  child.pid = 4321;
  return child;
}

interface CapturingHost {
  providers: Map<string, () => PendingWakeup[]>;
  disposedKeys: string[];
  registerPendingWorkProvider: (source: string, provider: () => PendingWakeup[]) => () => void;
}

function makeHost(): CapturingHost {
  const providers = new Map<string, () => PendingWakeup[]>();
  const disposedKeys: string[] = [];
  return {
    providers,
    disposedKeys,
    registerPendingWorkProvider(source, provider) {
      providers.set(source, provider);
      return () => {
        if (providers.get(source) === provider) {
          providers.delete(source);
          disposedKeys.push(source);
        }
      };
    },
  };
}

function spawnTask(registry: BgRegistry, access: BackgroundAccess, command: string): void {
  registry.register(makeFakeChild(), {
    command,
    workdir,
    access,
    intervalMs: 60_000,
    quietAfterMs: 30_000,
  } satisfies Partial<BgRegisterOptions> as BgRegisterOptions);
}

function makeInitCtx(agentId: string): Parameters<ShellFeature['getAsyncTools']>[0] {
  const bashPath = findGitBashPath(undefined);
  return {
    agentId,
    config: {},
    logger: console,
    featureConfig: bashPath ? { bashPath } : {},
    getFeature: () => undefined,
    registerTool: () => {},
    dataSourceRegistry: {},
  } as Parameters<ShellFeature['getAsyncTools']>[0];
}

describe('ShellFeature pending-work 申报', () => {
  it('access 未创建（本实例未装配后台工具）时不注册 provider', () => {
    const feature = new ShellFeature({ workspaceDir: workdir });
    const host = makeHost();
    feature.registerPendingWorkOnCallStart({ agent: host } as never);
    expect(host.providers.size).toBe(0);
  });

  it('getAsyncTools 后经实例 access 申报：running 任务映射 {source,id,summary}；非 running 排除', async () => {
    const feature = new ShellFeature({ workspaceDir: workdir });
    await feature.getAsyncTools(makeInitCtx('agent-shell-susp-provider'));
    const registry = feature.getBgRegistry();
    const access = feature.getBackgroundAccess();
    if (!registry || !access) {
      // 本机无 Bash：跳过接线断言（与 bg-observer.test.ts 同一降级策略）。
      return;
    }

    spawnTask(registry, access, 'npm run build');
    spawnTask(registry, access, 'npm run test');
    const killed = registry.list().find(snap => snap.command === 'npm run test')!;
    registry.kill(killed.id, { graceful: false, manual: false });

    const host = makeHost();
    feature.registerPendingWorkOnCallStart({ agent: host } as never);
    expect(host.providers.size).toBe(1);
    const provider = [...host.providers.values()][0]!;
    expect(provider()).toEqual([
      { source: 'shell', id: 'bg-1', summary: 'npm run build' },
    ]);
  });

  it('已有后台接入时缺少宿主注册契约显式失败，不静默漏报', async () => {
    const feature = new ShellFeature({ workspaceDir: workdir });
    await feature.getAsyncTools(makeInitCtx('agent-shell-susp-missing-host'));
    if (!feature.getBackgroundAccess()) return;
    try {
      expect(() => feature.registerPendingWorkOnCallStart({ agent: {} } as never))
        .toThrow(/registerPendingWorkProvider/);
    } finally {
      await feature.onDestroy();
    }
  });

  it('重复 CallStart 幂等：先注销旧注册再挂接，不积累闭包', async () => {
    const feature = new ShellFeature({ workspaceDir: workdir });
    await feature.getAsyncTools(makeInitCtx('agent-shell-susp-idem'));
    const registry = feature.getBgRegistry();
    if (!registry || !feature.getBackgroundAccess()) return;

    const host = makeHost();
    feature.registerPendingWorkOnCallStart({ agent: host } as never);
    feature.registerPendingWorkOnCallStart({ agent: host } as never);
    expect(host.providers.size).toBe(1);
    expect(host.disposedKeys.length).toBe(1);
  });

  it('onDestroy 经 disposer 注销 provider（销毁不残留回调）', async () => {
    const feature = new ShellFeature({ workspaceDir: workdir });
    await feature.getAsyncTools(makeInitCtx('agent-shell-susp-destroy'));
    if (!feature.getBackgroundAccess()) return;
    const host = makeHost();
    feature.registerPendingWorkOnCallStart({ agent: host } as never);
    expect(host.providers.size).toBe(1);
    await feature.onDestroy();
    expect(host.providers.size).toBe(0);
    expect(feature.getBackgroundAccess()).toBeNull();
  });
});

describe('任务归属盖戳与多会话隔离', () => {
  it('登记归属经 access 声明捕获：快照暴露；未声明为 null（现状兼容）', () => {
    const registry = new BgRegistry({ enableExitGuard: false });
    const access = new BackgroundAccess({
      source: 'shell',
      sessionId: 'sess-1',
      deliver: async () => {},
    });
    spawnTask(registry, access, 'cmd-a');
    expect(registry.list()[0]!.sessionId).toBe('sess-1');

    const bare = new BgRegistry({ enableExitGuard: false });
    const bareAccess = new BackgroundAccess({ source: 'shell', deliver: async () => {} });
    spawnTask(bare, bareAccess, 'cmd-b');
    expect(bare.list()[0]!.sessionId).toBeNull();
  });

  it('共享登记表多实例（多会话）：任务归属随各自 access 固定，不被收养改写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdev-shell-susp-adopt-'));
    const featureA = new ShellFeature({ workspaceDir: dir, sessionId: 'sess-a' });
    await featureA.getAsyncTools(makeInitCtx('agent-shell-adopt'));
    const registryA = featureA.getBgRegistry();
    const accessA = featureA.getBackgroundAccess();
    if (!registryA || !accessA) {
      // 本机无 Bash：跳过（同一降级策略）。
      return;
    }
    spawnTask(registryA, accessA, 'cmd-by-a');

    // 模拟同进程新会话实例：收养共享任务表，但归属 access 各自独立。
    const featureB = new ShellFeature({ workspaceDir: dir, sessionId: 'sess-b' });
    await featureB.getAsyncTools(makeInitCtx('agent-shell-adopt'));
    expect(featureB.getBgRegistry()).toBe(registryA);
    const registryB = featureB.getBgRegistry()!;
    const accessB = featureB.getBackgroundAccess()!;
    expect(accessB).not.toBe(accessA);

    spawnTask(registryB, accessB, 'cmd-by-b');
    const byCommand = new Map(registryB.list().map(snap => [snap.command, snap.sessionId]));
    expect(byCommand.get('cmd-by-a')).toBe('sess-a'); // 已登记归属不变
    expect(byCommand.get('cmd-by-b')).toBe('sess-b'); // 新任务盖登记方会话
  });

  it('pending 申报按归属实例隔离：A 不串报 B 的任务（修复 5）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdev-shell-susp-x-'));
    const featureA = new ShellFeature({ workspaceDir: dir, sessionId: 'sess-a' });
    await featureA.getAsyncTools(makeInitCtx('agent-shell-susp-iso'));
    const registryA = featureA.getBgRegistry();
    const accessA = featureA.getBackgroundAccess();
    if (!registryA || !accessA) return;

    const featureB = new ShellFeature({ workspaceDir: dir, sessionId: 'sess-b' });
    await featureB.getAsyncTools(makeInitCtx('agent-shell-susp-iso'));
    const accessB = featureB.getBackgroundAccess()!;

    spawnTask(registryA!, accessA, 'task-of-a');
    spawnTask(registryA!, accessB, 'task-of-b');

    const hostA = makeHost();
    const hostB = makeHost();
    featureA.registerPendingWorkOnCallStart({ agent: hostA } as never);
    featureB.registerPendingWorkOnCallStart({ agent: hostB } as never);
    const providerA = [...hostA.providers.values()][0]!;
    const providerB = [...hostB.providers.values()][0]!;
    expect(providerA().map(w => w.id)).toEqual(['bg-1']);
    expect(providerB().map(w => w.id)).toEqual(['bg-2']);
  });

  it('待命意图按实例隔离：A 的 standby 不被 B 消费，且要求真实可等工作（修复 5、7）', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'agentdev-shell-susp-sb-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'agentdev-shell-susp-sb-b-'));
    const featureA = new ShellFeature({ workspaceDir: dirA, sessionId: 'sess-a' });
    const featureB = new ShellFeature({ workspaceDir: dirB, sessionId: 'sess-b' });
    await featureA.getAsyncTools(makeInitCtx('agent-shell-susp-standby-a'));
    await featureB.getAsyncTools(makeInitCtx('agent-shell-susp-standby-b'));
    const accessA = featureA.getBackgroundAccess();
    const accessB = featureB.getBackgroundAccess();
    const registryA = featureA.getBgRegistry();
    if (!accessA || !accessB || !registryA) return;

    // 无登记工作时盲登记的待命不生效（不能空待命）。
    accessA.requestStandby();
    expect(accessA.consumeStandbyRequest()).toBe(false);

    // 有真实登记工作后：意图只被归属实例消费，不串会话。
    spawnTask(registryA, accessA, 'task-of-a');
    accessA.requestStandby();
    expect(accessB.consumeStandbyRequest()).toBe(false); // B 不消费 A 的意图
    expect(accessA.consumeStandbyRequest()).toBe(true);
  });
});

describe('通知投递 body 携带 sessionId（user-turn 契约）', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeDeliverableRegistry(sessionId?: string): { registry: BgRegistry; access: BackgroundAccess } {
    const registry = new BgRegistry({ enableExitGuard: false });
    const access = new BackgroundAccess({
      source: 'shell',
      ...(sessionId ? { sessionId } : {}),
      deliver: (async () => {}) as never,
      aggregationWindowMs: 250,
    });
    return { registry, access };
  }

  it('声明的 access：body 带 sessionId/kind/source 与事件、工作身份分离的 metadata', async () => {
    const { createViewerUserTurnDeliver } = await import('../src/bg-core.js');
    const { registry, access } = makeDeliverableRegistry('sess-9');
    const deliver = createViewerUserTurnDeliver('agent-deliver');
    // 直接经适配器验证 body 形状（事件身份 / 工作身份 / 会话路由）。
    await deliver({
      eventId: 'evt-test-1',
      text: 'payload',
      workIds: ['bg-1', 'bg-2'],
      sessionId: 'sess-9',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/agents/agent-deliver/user-turn');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.kind).toBe('reminder');
    expect(body.source).toBe('shell');
    expect(body.sessionId).toBe('sess-9');
    expect(body.sourceRef).toBe('evt-test-1'); // 事件身份作网关幂等键
    expect(body.metadata).toEqual({ shell: { taskId: 'bg-2', taskIds: ['bg-1', 'bg-2'] } });
    void registry;
    void access;
  });

  it('未声明的 access：body 不含 sessionId 字段（现状兼容）', async () => {
    const { createViewerUserTurnDeliver } = await import('../src/bg-core.js');
    const deliver = createViewerUserTurnDeliver('agent-deliver-bare');
    await deliver({ eventId: 'evt-test-2', text: 'payload', workIds: ['bg-1'], sessionId: undefined });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('sessionId');
  });

  it('送达判定核验 payload：HTTP 200 {success:false} 不算投递成功', async () => {
    const { createViewerUserTurnDeliver } = await import('../src/bg-core.js');
    const deliver = createViewerUserTurnDeliver('agent-deliver-reject');
    // ViewerWorker 真实形状：4xx 也可能带 200 包装层（如代理改写），payload
    // 显式 success:false 必须拒绝。
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, code: 'runtime_not_accepting_input', error: 'Agent runtime is not connected' }),
    });
    await expect(deliver({ eventId: 'evt-r1', text: 'x', workIds: ['bg-1'] }))
      .rejects.toThrow(/runtime_not_accepting_input/);
  });

  it('送达判定核验 payload：HTTP 200 {ok:false}（Claw 本地失败形状）不算投递成功', async () => {
    const { createViewerUserTurnDeliver } = await import('../src/bg-core.js');
    const deliver = createViewerUserTurnDeliver('agent-deliver-reject-ok');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, code: 'thread_closed', error: 'Thread is closed' }),
    });
    await expect(deliver({ eventId: 'evt-r2', text: 'x', workIds: ['bg-1'] }))
      .rejects.toThrow(/thread_closed/);
  });

  it('送达判定核验 payload：损坏响应（非 JSON / 非对象）不算投递成功', async () => {
    const { createViewerUserTurnDeliver } = await import('../src/bg-core.js');
    const deliver = createViewerUserTurnDeliver('agent-deliver-corrupt');
    // 非 JSON 体（网关 502 HTML 页、截断响应等）。
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await expect(deliver({ eventId: 'evt-c1', text: 'x', workIds: ['bg-1'] }))
      .rejects.toThrow(/unparseable response body/);

    // 可解析但不是对象。
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ['unexpected'] });
    await expect(deliver({ eventId: 'evt-c2', text: 'x', workIds: ['bg-1'] }))
      .rejects.toThrow(/unexpected response payload/);
  });

  it('送达判定：HTTP 200 {success:true} 成功（真实 ViewerWorker 形状）', async () => {
    const { createViewerUserTurnDeliver } = await import('../src/bg-core.js');
    const deliver = createViewerUserTurnDeliver('agent-deliver-ok');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, delivery: 'queued' }),
    });
    await expect(deliver({ eventId: 'evt-ok', text: 'x', workIds: ['bg-1'], sessionId: 'sess-1' })).resolves.toBeUndefined();
  });
});
