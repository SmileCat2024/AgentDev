/**
 * BgRegistry 观察者（宿主集成镜像面）测试
 *
 * 覆盖：
 * - 六类事件的发射时机：registered / output / report / ready / finalized / tuned
 * - output 节流：每任务 ≥1s 一发；终态不受节流影响
 * - 观察者抛错不影响引擎（后续事件与通知管线照常）
 * - 未注册观察者时行为不变
 * - ShellFeature：bgObserver 透传 + getBgRegistry 访问器
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BgRegistry,
  type BgObserverEvent,
} from '../src/bg-core.js';
import { ShellFeature, findGitBashPath } from '../src/index.js';

const workdir = mkdtempSync(join(tmpdir(), 'agentdev-shell-bg-obs-'));

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

interface ObservedHarness {
  registry: BgRegistry;
  events: BgObserverEvent[];
  spawn: (opts?: { readyPattern?: string | null }) => { child: FakeChild; id: string };
}

function makeObservedHarness(onEvent?: (event: BgObserverEvent) => void): ObservedHarness {
  const events: BgObserverEvent[] = [];
  const registry = new BgRegistry({
    agentId: 'agent-obs-test',
    enableExitGuard: false,
    deliverImpl: async () => {},
    observer: (event) => {
      events.push(event);
      onEvent?.(event);
    },
  });
  let seq = 0;
  const spawn = (opts: { readyPattern?: string | null } = {}) => {
    const child = makeFakeChild();
    seq++;
    const task = registry.register(child, {
      command: `cmd-${seq}`,
      workdir,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
      readyPattern: opts.readyPattern ?? null,
    });
    return { child, id: task.id };
  };
  return { registry, events, spawn };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('事件发射时机', () => {
  it('register 发出 registered，事件携带对应任务', () => {
    const { events, spawn } = makeObservedHarness();
    const { id } = spawn();
    expect(events.map((e) => e.kind)).toEqual(['registered']);
    expect(events[0].task.id).toBe(id);
    expect(events[0].task.status).toBe('running');
  });

  it('首块输出发 output，1s 内后续输出被节流，超过 1s 再次发射', () => {
    const { events, spawn } = makeObservedHarness();
    const { child } = spawn();
    child.stdout.emit('data', 'chunk-1\n');
    expect(events.filter((e) => e.kind === 'output').length).toBe(1);
    child.stdout.emit('data', 'chunk-2\n');
    child.stderr.emit('data', 'chunk-3\n');
    expect(events.filter((e) => e.kind === 'output').length).toBe(1); // 节流窗口内
    vi.advanceTimersByTime(1_001);
    child.stdout.emit('data', 'chunk-4\n');
    expect(events.filter((e) => e.kind === 'output').length).toBe(2);
  });

  it('节拍触发发 report（interval 与 quiet 都算）', async () => {
    const { events, spawn } = makeObservedHarness();
    const { child } = spawn({ readyPattern: null });
    // quiet 到期（无输出 30s）
    await vi.advanceTimersByTimeAsync(30_001);
    expect(events.filter((e) => e.kind === 'report').length).toBe(1);
    // interval 到期（注册后 60s 纯墙钟）
    await vi.advanceTimersByTimeAsync(30_001);
    expect(events.filter((e) => e.kind === 'report').length).toBe(2);
  });

  it('readyPattern 匹配发一次 ready，重复匹配不再发', () => {
    const { events, spawn } = makeObservedHarness();
    const { child } = spawn({ readyPattern: 'listening' });
    child.stdout.emit('data', 'server listening on :5173\n');
    expect(events.filter((e) => e.kind === 'ready').length).toBe(1);
    child.stdout.emit('data', 'still listening\n');
    expect(events.filter((e) => e.kind === 'ready').length).toBe(1);
  });

  it('close 终态发 finalized，任务状态已更新为 done', () => {
    const { events, spawn } = makeObservedHarness();
    const { child } = spawn();
    child.emit('close', 0);
    const finalized = events.filter((e) => e.kind === 'finalized');
    expect(finalized.length).toBe(1);
    expect(finalized[0].task.status).toBe('done');
    expect(finalized[0].task.exitCode).toBe(0);
  });

  it('kill 终态同样发 finalized（killed）', () => {
    const { events, registry, spawn } = makeObservedHarness();
    const { id } = spawn();
    registry.kill(id);
    const finalized = events.filter((e) => e.kind === 'finalized');
    expect(finalized.length).toBe(1);
    expect(finalized[0].task.status).toBe('killed');
  });

  it('tune 发 tuned', () => {
    const { events, registry, spawn } = makeObservedHarness();
    const { id } = spawn();
    registry.tune(id, { intervalMs: 120_000, quietAfterMs: 60_000 });
    expect(events.filter((e) => e.kind === 'tuned').length).toBe(1);
  });

  it('终态后 output 不再发射（残余数据丢弃），finalized 是最后一个事件', () => {
    const { events, spawn } = makeObservedHarness();
    const { child } = spawn();
    vi.advanceTimersByTime(1_001); // 越过节流窗口
    child.emit('close', 1);
    child.stdout.emit('data', 'ghost output\n');
    const kinds = events.map((e) => e.kind);
    expect(kinds[kinds.length - 1]).toBe('finalized');
    expect(kinds.filter((k) => k === 'output').length).toBe(0);
  });
});

describe('健壮性', () => {
  it('观察者抛错被吞，引擎与后续事件不受影响', async () => {
    const events: BgObserverEvent[] = [];
    const registry = new BgRegistry({
      agentId: 'agent-obs-throw',
      enableExitGuard: false,
      deliverImpl: async () => {},
      observer: (event) => {
        if (event.kind === 'registered') throw new Error('observer boom');
        events.push(event);
      },
    });
    const child = makeFakeChild();
    const task = registry.register(child, {
      command: 'cmd-throw',
      workdir,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
    });
    expect(task.status).toBe('running'); // 引擎未受影响
    child.stdout.emit('data', 'out\n'); // output 路径抛错点之后
    await vi.advanceTimersByTimeAsync(30_001); // quiet 节拍照常
    expect(events.some((e) => e.kind === 'report')).toBe(true);
    child.emit('close', 0);
    expect(events.some((e) => e.kind === 'finalized')).toBe(true);
  });

  it('未注册观察者时 register/输出/终态照常', () => {
    const registry = new BgRegistry({
      agentId: 'agent-no-obs',
      enableExitGuard: false,
      deliverImpl: async () => {},
    });
    const child = makeFakeChild();
    const task = registry.register(child, {
      command: 'cmd-no-obs',
      workdir,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
    });
    expect(() => child.stdout.emit('data', 'x\n')).not.toThrow();
    child.emit('close', 0);
    expect(task.status).toBe('done');
  });
});

describe('ShellFeature 集成面', () => {
  it('getBgRegistry 初始为 null，装配 bgObserver 后经 getAsyncTools 建表并接线', async () => {
    const events: BgObserverEvent[] = [];
    const feature = new ShellFeature({
      workspaceDir: workdir,
      bgObserver: (event) => events.push(event),
    });
    expect(feature.getBgRegistry()).toBeNull();

    const bashPath = findGitBashPath(undefined);
    const ctx = {
      agentId: 'agent-feature-obs',
      config: {},
      logger: console,
      featureConfig: bashPath ? { bashPath } : {},
      getFeature: () => undefined,
      registerTool: () => {},
      dataSourceRegistry: {},
    } as Parameters<typeof feature.getAsyncTools>[0];
    await feature.getAsyncTools(ctx);

    const registry = feature.getBgRegistry();
    if (!registry) {
      // 本机无 Bash（Linux 无 Git Bash 等）：跳过接线断言，仅验证不抛错。
      return;
    }
    const child = makeFakeChild();
    registry.register(child, {
      command: 'cmd-feature',
      workdir,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
    });
    expect(events.map((e) => e.kind)).toEqual(['registered']);
  });

  it('进程级共享：同 agentId+workdir 的后建实例复用同一 registry，observer 各自接线', async () => {
    const eventsA: BgObserverEvent[] = [];
    const eventsB: BgObserverEvent[] = [];
    const bashPath = findGitBashPath(undefined);
    const makeCtx = (feature: ShellFeature, agentId: string) =>
      ({
        agentId,
        config: {},
        logger: console,
        featureConfig: bashPath ? { bashPath } : {},
        getFeature: () => undefined,
        registerTool: () => {},
        dataSourceRegistry: {},
      }) as Parameters<typeof feature.getAsyncTools>[0];

    const featureA = new ShellFeature({ workspaceDir: workdir, bgObserver: (e) => eventsA.push(e) });
    await featureA.getAsyncTools(makeCtx(featureA, 'agent-shared-reg'));
    const registryA = featureA.getBgRegistry();
    if (!registryA) {
      // 本机无 Bash：跳过共享断言（与上方集成用例同一降级策略）。
      return;
    }

    // 模拟同进程新会话实例：Agent 实例新建，任务表应复用而非另起空表。
    const featureB = new ShellFeature({ workspaceDir: workdir, bgObserver: (e) => eventsB.push(e) });
    expect(featureB.getBgRegistry()).toBeNull();
    await featureB.getAsyncTools(makeCtx(featureB, 'agent-shared-reg'));
    expect(featureB.getBgRegistry()).toBe(registryA);

    const child = makeFakeChild();
    registryA.register(child, {
      command: 'cmd-shared',
      workdir,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
    });
    // 两个会话的 observer 都收到事件；存量任务对后建实例可见。
    expect(eventsA.map((e) => e.kind)).toEqual(['registered']);
    expect(eventsB.map((e) => e.kind)).toEqual(['registered']);
    expect(featureB.getBgRegistry()!.list()).toHaveLength(1);

    // 不同 workdir 不共享（测试隔离语义）。
    const featureC = new ShellFeature({ workspaceDir: `${workdir}-c`, bgObserver: () => {} });
    await featureC.getAsyncTools(makeCtx(featureC, 'agent-shared-reg'));
    expect(featureC.getBgRegistry()).not.toBe(registryA);
  });
});
