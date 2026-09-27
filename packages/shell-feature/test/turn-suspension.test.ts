/**
 * 轮次挂起语义（ADR-0019 阶段 1）shell 侧测试
 *
 * 覆盖：
 * - ShellFeature 申报 provider：running 任务映射 {source:'shell', id, summary:command}，
 *   非运行任务排除；registry 未建表时申报空
 * - 任务登记盖戳建表会话 sessionId：快照暴露；共享表收养更新归属锚点（旧任务不变）
 * - 通知投递（user-turn）body 携带 sessionId；未声明时无该字段（行为与现状一致）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BgRegistry } from '../src/bg-core.js';
import { ShellFeature, findGitBashPath } from '../src/index.js';
import type { PendingWakeup } from '@agentdevjs/core';
import type { BgRegisterOptions } from '../src/bg-core.js';

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

function spawnTask(registry: BgRegistry, command: string): void {
  registry.register(makeFakeChild(), {
    command,
    workdir,
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

/** 捕获 ShellFeature 向 agent 申报的 provider。 */
function captureProvider(feature: ShellFeature): (() => PendingWakeup[]) | null {
  let captured: (() => PendingWakeup[]) | null = null;
  feature.registerPendingWorkOnCallStart({
    agent: {
      registerPendingWorkProvider: (_source: string, provider: () => PendingWakeup[]) => {
        captured = provider;
      },
    },
  } as never);
  return captured;
}

describe('ShellFeature pending-work 申报', () => {
  it('registry 未建表（本实例未起过后台任务）时申报空数组', () => {
    const feature = new ShellFeature({ workspaceDir: workdir });
    const provider = captureProvider(feature);
    expect(provider).not.toBeNull();
    expect(provider!()).toEqual([]);
  });

  it('从共享 BgRegistry 取 running 任务映射 {source,id,summary}；非 running 排除', async () => {
    const feature = new ShellFeature({ workspaceDir: workdir });
    await feature.getAsyncTools(makeInitCtx('agent-shell-susp-provider'));
    const registry = feature.getBgRegistry();
    if (!registry) {
      // 本机无 Bash：跳过接线断言（与 bg-observer.test.ts 同一降级策略）。
      return;
    }

    spawnTask(registry, 'npm run build');
    spawnTask(registry, 'npm run test');
    const killed = registry.list().find(snap => snap.command === 'npm run test')!;
    registry.kill(killed.id, { graceful: false, manual: false });

    const provider = captureProvider(feature);
    expect(provider!()).toEqual([
      { source: 'shell', id: 'bg-1', summary: 'npm run build' },
    ]);
  });
});

describe('任务登记盖戳建表会话 sessionId', () => {
  it('registry 声明 sessionId 时登记任务携带归属，快照暴露', () => {
    const registry = new BgRegistry({
      agentId: 'agent-stamp',
      sessionId: 'sess-1',
      enableExitGuard: false,
      deliverImpl: async () => {},
    });
    spawnTask(registry, 'cmd-a');
    expect(registry.list()[0]!.sessionId).toBe('sess-1');
  });

  it('未声明 sessionId 时快照为 null（行为与现状一致）', () => {
    const registry = new BgRegistry({
      agentId: 'agent-bare',
      enableExitGuard: false,
      deliverImpl: async () => {},
    });
    spawnTask(registry, 'cmd-b');
    expect(registry.list()[0]!.sessionId).toBeNull();
  });

  it('setSessionId 更新锚点：新任务盖新值，已登记任务保持登记时刻事实', () => {
    const registry = new BgRegistry({
      agentId: 'agent-adopt',
      sessionId: 'sess-old',
      enableExitGuard: false,
      deliverImpl: async () => {},
    });
    spawnTask(registry, 'cmd-old');
    registry.setSessionId('sess-new');
    spawnTask(registry, 'cmd-new');

    const byCommand = new Map(registry.list().map(snap => [snap.command, snap.sessionId]));
    expect(byCommand.get('cmd-old')).toBe('sess-old');
    expect(byCommand.get('cmd-new')).toBe('sess-new');
  });

  it('同 agentId+workdir 的后建实例收养共享表时更新归属锚点', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdev-shell-susp-adopt-'));
    const featureA = new ShellFeature({ workspaceDir: dir, sessionId: 'sess-a' });
    await featureA.getAsyncTools(makeInitCtx('agent-shell-adopt'));
    const registryA = featureA.getBgRegistry();
    if (!registryA) {
      // 本机无 Bash：跳过（同一降级策略）。
      return;
    }
    spawnTask(registryA, 'cmd-by-a');

    const featureB = new ShellFeature({ workspaceDir: dir, sessionId: 'sess-b' });
    await featureB.getAsyncTools(makeInitCtx('agent-shell-adopt'));
    expect(featureB.getBgRegistry()).toBe(registryA);

    const registryB = featureB.getBgRegistry()!;
    spawnTask(registryB, 'cmd-by-b');
    const byCommand = new Map(registryB.list().map(snap => [snap.command, snap.sessionId]));
    expect(byCommand.get('cmd-by-a')).toBe('sess-a');
    expect(byCommand.get('cmd-by-b')).toBe('sess-b');
  });
});

describe('通知投递 body 携带 sessionId（user-turn 契约）', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('声明的 registry：body 带 sessionId/kind/source/metadata', async () => {
    const registry = new BgRegistry({
      agentId: 'agent-deliver',
      sessionId: 'sess-9',
      enableExitGuard: false,
    });
    const child = makeFakeChild();
    registry.register(child, {
      command: 'sleep 100',
      workdir,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
    });

    // 推过静默窗口 + 聚合窗口，触发一次 quiet 汇报投递。
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(251);

    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/api/agents/agent-deliver/user-turn');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.kind).toBe('reminder');
    expect(body.source).toBe('shell');
    expect(body.sessionId).toBe('sess-9');
    expect(body.metadata).toEqual({ shell: { taskId: body.sourceRef } });
  });

  it('未声明的 registry：body 不含 sessionId 字段（现状兼容）', async () => {
    const registry = new BgRegistry({
      agentId: 'agent-deliver-bare',
      enableExitGuard: false,
    });
    registry.register(makeFakeChild(), {
      command: 'sleep 100',
      workdir,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(251);

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('sessionId');
  });
});
