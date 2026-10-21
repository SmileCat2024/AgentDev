/**
 * 通知事件身份与工作身份分离（网关幂等缺陷修复）专项测试
 *
 * 背景：Claw 线程域以 body.sourceRef 作幂等键（gw-${sourceRef}）。旧实现
 * sourceRef = taskId，同任务的后续周期/终态 reminder 会被判重复吞掉；聚合
 * 批只带末任务 id，丢失其余工作关联。修复后：
 * - sourceRef = 通知事件身份（eventId，每批次稳定唯一）→ 同任务两次进度 +
 *   终态都可达，不被幂等去重吞掉；
 * - metadata.shell.taskId 保留旧显示契约（批内末任务）；
 *   metadata.shell.taskIds 携带批内全部相关任务（聚合不丢关联）；
 * - 会话归属在通知创建时捕获（登记盖戳），分组不回退当前会话。
 *
 * 另覆盖：终态优先（exit 赢，replacesPending 领域声明）、失败滞留与补取、
 * 失败结果不被 done 保留上限裁掉、bg_tune 仅 standby 的现状返回（不盲登记）。
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundAccess } from '@agentdevjs/core';
import type { WakeupDeliveryEvent, WakeupDeliver } from '@agentdevjs/core';
import { BgRegistry, BG_KEEP_DONE } from '../src/bg-core.js';
import type { BgRegisterOptions } from '../src/bg-core.js';
import { createBgTuneTool } from '../src/index.js';

const workdir = mkdtempSync(join(tmpdir(), 'agentdev-shell-notify-id-'));

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

interface Harness {
  registry: BgRegistry;
  access: BackgroundAccess;
  events: WakeupDeliveryEvent[];
  spawn: (opts?: Partial<BgRegisterOptions>) => { child: FakeChild; id: string };
}

/** 当前用例的 harness（afterEach 统一清理：杀任务、关流、弃定时器）。 */
let h: Harness | null = null;

function makeHarness(deliver?: WakeupDeliver): Harness {
  const events: WakeupDeliveryEvent[] = [];
  const registry = new BgRegistry({ enableExitGuard: false });
  const access = new BackgroundAccess({
    source: 'shell',
    deliver: deliver ?? (async (event) => { events.push(event); }),
    aggregationWindowMs: 250,
    onWorkRelease: () => registry.trimDone(),
  });
  let seq = 0;
  const spawn = (opts: Partial<BgRegisterOptions> = {}) => {
    const child = makeFakeChild();
    seq++;
    const task = registry.register(child, {
      command: `cmd-${seq}`,
      workdir,
      access,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
      ...opts,
    });
    return { child, id: task.id };
  };
  return { registry, access, events, spawn };
}

async function flushAggregation(): Promise<void> {
  await vi.advanceTimersByTimeAsync(251);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // 假 child 的 kill 是 vi.fn（非真实 tree kill，不碰系统进程）；dispose 走
  // 非 graceful 路径同步终止全部任务并 end 日志流，无定时器/流残留。
  h?.registry.dispose();
  h = null;
  vi.useRealTimers(); // 丢弃未触发的 fake 定时器（flush/quiet 均不跨用例泄漏）
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('通知事件身份（网关幂等键契约）', () => {
  it('同任务两次进度 + 终态都可达：三次投递、每事件稳定唯一 eventId', async () => {
    h = makeHarness();
    const { child, id } = h.spawn({ intervalMs: 60_000, quietAfterMs: 120_000 });

    // 两次进度（不同 tick，各自成批）+ 终态。
    await vi.advanceTimersByTimeAsync(20_000);
    child.stdout.emit('data', 'step-1\n');
    await vi.advanceTimersByTimeAsync(40_000); // t=60s：第一次节拍
    await flushAggregation();
    await vi.advanceTimersByTimeAsync(60_000); // t=120s：第二次节拍
    await flushAggregation();
    child.emit('close', 0);
    await flushAggregation();

    expect(h.events.length).toBe(3);
    const ids = h.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(3); // 每事件唯一 → 网关逐条放行，不判重吞掉
    for (const event of h.events) {
      expect(event.workIds).toEqual([id]); // 工作身份完整关联
    }
    expect(h.events[0]!.text).toContain('周期汇报');
    expect(h.events[1]!.text).toContain('周期汇报');
    expect(h.events[2]!.text).toContain('已完成');
  });

  it('聚合批跨任务不丢关联：taskIds 全量、taskId 保留末任务显示契约', async () => {
    h = makeHarness();
    const a = h.spawn({});
    const b = h.spawn({});
    a.child.emit('close', 0);
    b.child.emit('close', 1);
    await flushAggregation();

    expect(h.events.length).toBe(1);
    const event = h.events[0]!;
    expect(event.workIds).toEqual([a.id, b.id]);
    // 事件身份 ≠ 工作身份：sourceRef 不再复用任何 taskId。
    expect(event.eventId).not.toBe(a.id);
    expect(event.eventId).not.toBe(b.id);
  });

  it('投递失败滞留的事件身份在补取时保持可追溯（身份稳定）', async () => {
    h = makeHarness(async () => {
      throw new Error('viewer down');
    });
    const { child, id } = h.spawn({});
    child.emit('close', 0);
    await flushAggregation();
    expect(h.events.length).toBe(0);
    expect(h.access.hasUndelivered(id)).toBe(true);

    // bg_status 补取：终态结果交到模型手里，工作释放、不再判 pending。
    const task = h.registry.get(id)!;
    const view = h.registry.statusView(task);
    expect(view.unsentCatchUp.length).toBe(1);
    expect(view.unsentCatchUp[0]).toContain('已完成');
    expect(h.access.hasUndelivered(id)).toBe(false);
    expect(h.access.pendingWakeups()).toEqual([]);
  });
});

describe('终态优先与保留保护', () => {
  it('exit 赢：终态入队替换同任务待发的周期通知（replacesPending）', async () => {
    h = makeHarness();
    const { child, id } = h.spawn({ intervalMs: 60_000, quietAfterMs: 60_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    child.stdout.emit('data', 'final\n');
    // 周期通知与终态同窗口：终态在队，周期（同一 access）入队后被替换。
    await vi.advanceTimersByTimeAsync(44_999);
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(2);
    await flushAggregation();

    expect(h.events.length).toBe(1);
    expect(h.events[0]!.text).toContain('已完成');
    expect(h.events[0]!.text).not.toContain('周期汇报'); // 待发周期被替换
    expect(h.events[0]!.workIds).toEqual([id]);
  });

  it('失败结果不被 done 保留上限裁掉：未送达事实优先于 BG_KEEP_DONE', async () => {
    h = makeHarness(async () => {
      throw new Error('viewer down');
    });
    const children: FakeChild[] = [];
    const ids: string[] = [];
    for (let i = 0; i < BG_KEEP_DONE + 3; i++) {
      const { child, id } = h.spawn({});
      children.push(child);
      ids.push(id);
      child.emit('close', 0);
    }
    await flushAggregation();
    // 全部未送达：一个都不能裁（结果还没交到模型手里）。
    expect(h.registry.list().length).toBe(BG_KEEP_DONE + 3);
    for (const id of ids) {
      expect(h.access.hasUndelivered(id)).toBe(true);
      expect(h.access.pendingWakeups().map(w => w.id)).toContain(id);
    }
  });

  it('送达成功后终态任务恢复裁剪：保留上限回到 BG_KEEP_DONE', async () => {
    const h = makeHarness();
    const children: FakeChild[] = [];
    for (let i = 0; i < BG_KEEP_DONE + 2; i++) {
      const { child } = h.spawn({});
      children.push(child);
      child.emit('close', 0);
    }
    await flushAggregation(); // 全部送达 + 释放 → onWorkRelease 联动裁剪
    expect(h.registry.list().length).toBe(BG_KEEP_DONE);
  });

  it('manual 打断通知先于裁剪入队：done 全受保护时新 killed 任务不被裁、可补取', async () => {
    h = makeHarness(async () => { throw new Error('viewer down'); });
    // 先造满 BG_KEEP_DONE 条 done，通知全部滞留（未送达事实保护，均不可裁）。
    for (let i = 0; i < BG_KEEP_DONE; i++) {
      const { child } = h.spawn({});
      child.emit('close', 0);
    }
    await flushAggregation();
    expect(h.registry.list().length).toBe(BG_KEEP_DONE);

    // 第 BG_KEEP_DONE+1 个任务被用户手动打断（面板路径）：此时裁剪富余额
    // 恰为 1，且老 done 全受保护——若通知晚于 trim 入队，本任务是唯一
    // 可裁项，会被裁掉导致 manual 通知失败后无从补取。
    const { id: killedId } = h.spawn({});
    expect(h.registry.kill(killedId, { manual: true })).toBe(true);
    await flushAggregation(); // manual 通知投递失败 → 滞留

    // 修复后：manual 通知先入队 → killed 任务带未送达事实受保护，不被裁。
    const task = h.registry.get(killedId);
    expect(task).not.toBeNull();
    expect(h.registry.list().length).toBe(BG_KEEP_DONE + 1);
    const view = h.registry.statusView(task!);
    expect(view.unsentCatchUp.some((t) => t.includes('已被用户手动打断'))).toBe(true);
    expect(h.access.hasUndelivered(killedId)).toBe(false);
  });

  it('主动 kill 释放等待：pending 停止申报，旧未送达事实保留补取', async () => {
    h = makeHarness(async () => { throw new Error('viewer down'); });
    const { child, id } = h.spawn({});
    child.stdout.emit('data', 'progress\n');
    await vi.advanceTimersByTimeAsync(60_000); // t=60s：周期通知投递失败 → unsent
    await flushAggregation();
    expect(h.access.hasUndelivered(id)).toBe(true);
    expect(h.access.pendingWakeups().map((w) => w.id)).toEqual([id]);

    // 模型主动停止（工具路径）：主动取消等待。
    expect(h.registry.kill(id)).toBe(true);
    // 释放后不再申报 pending（回合可自然完成，不悬挂已死任务）；
    expect(h.access.pendingWakeups()).toEqual([]);
    // 既有未送达事实保留：任务受裁剪保护，bg_status 仍可补取。
    expect(h.access.hasUndelivered(id)).toBe(true);
    const task = h.registry.get(id);
    expect(task).not.toBeNull();
    const view = h.registry.statusView(task!);
    expect(view.unsentCatchUp.some((t) => t.includes('progress'))).toBe(true);
    expect(h.access.hasUndelivered(id)).toBe(false);
  });
});

describe('bg_tune 仅 standby：不盲登记（返回现状）', () => {
  it('目标不存在：返回未找到，不登记待命', async () => {
    h = makeHarness();
    const tool = createBgTuneTool(h.registry, h.access);
    const out = await tool.execute!({ taskId: 'bg-404', then: 'standby' } as never, {} as never) as string;
    expect(out).toContain('未找到');
    expect(h.access.consumeStandbyRequest()).toBe(false);
  });

  it('目标已终态：返回终态现状，不登记待命', async () => {
    h = makeHarness();
    const { child, id } = h.spawn({});
    child.emit('close', 7);
    const tool = createBgTuneTool(h.registry, h.access);
    const out = await tool.execute!({ taskId: id, then: 'standby' } as never, {} as never) as string;
    expect(out).toContain('已结束');
    expect(out).toContain('退出码 7');
    expect(h.access.consumeStandbyRequest()).toBe(false);
  });

  it('目标运行中：正常登记一次性待命', async () => {
    h = makeHarness();
    const { id } = h.spawn({});
    const tool = createBgTuneTool(h.registry, h.access);
    const out = await tool.execute!({ taskId: id, then: 'standby' } as never, {} as never) as string;
    expect(out).toContain('已进入待命');
    expect(h.access.consumeStandbyRequest()).toBe(true);
  });
});
