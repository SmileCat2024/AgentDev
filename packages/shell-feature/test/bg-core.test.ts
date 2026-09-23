/**
 * 后台任务核心测试（bg-core）
 *
 * 覆盖：
 * - 双节奏引擎：interval 纯墙钟、quiet 被输出重置、任一触发即互重置
 * - 事件优先级：exit 赢（close 与节拍同时到达时丢弃节拍）、killed 幂等
 * - clamp：模型声明 clamp 到下限；inherited（前台转后台）允许低于下限
 * - readyPattern：一次性就绪通知 + 双节奏重置
 * - 通知管线：250ms 聚合合并、投递失败滞留 + bg_status 补发
 * - ring buffer：256KB 尾部保留 + 游标 clamp
 * - 前台语义（真实子进程）：超时转后台不打断；用户打断 kill + terminated
 * - bash_bg 快速捕获窗：2s 内完成直返
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BgRegistry,
  BG_MIN_INTERVAL_MS,
  BG_MIN_QUIET_MS,
  BG_RING_BUFFER_MAX_BYTES,
  runForegroundWithBudget,
  type BgRegisterOptions,
} from '../src/bg-core.js';
import { createBashBgTool, createShellCommandTool } from '../src/index.js';
import { findGitBashPath } from '../src/tools.js';

const workdir = mkdtempSync(join(tmpdir(), 'agentdev-shell-bg-'));

// ---------------------------------------------------------------------------
// 假 ChildProcess 工厂（节奏引擎纯逻辑测试）
// ---------------------------------------------------------------------------

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
  child.pid = 4242;
  return child;
}

interface Harness {
  registry: BgRegistry;
  deliveries: Array<{ text: string; sourceRef: string }>;
  spawn: (opts?: Partial<BgRegisterOptions>) => { child: FakeChild; id: string };
}

function makeHarness(deliverImpl?: (text: string, ref: string) => Promise<void>): Harness {
  const deliveries: Array<{ text: string; sourceRef: string }> = [];
  const defaultDeliver = async (text: string, sourceRef: string) => {
    deliveries.push({ text, sourceRef });
  };
  const registry = new BgRegistry({
    agentId: 'agent-bg-test',
    enableExitGuard: false,
    deliverImpl: deliverImpl ?? defaultDeliver,
  });
  let seq = 0;
  const spawn = (opts: Partial<BgRegisterOptions> = {}) => {
    const child = makeFakeChild();
    seq++;
    const task = registry.register(child, {
      command: `cmd-${seq}`,
      workdir,
      intervalMs: 60_000,
      quietAfterMs: 30_000,
      ...opts,
    });
    return { child, id: task.id };
  };
  return { registry, deliveries, spawn };
}

async function flushAggregation() {
  // 聚合窗口 250ms：推过窗口并让 async deliver 完成。
  await vi.advanceTimersByTimeAsync(251);
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('双节奏引擎', () => {
  it('风暴回归：interval 与 quiet 同刻双到期时只发一条，不产生零延迟循环', async () => {
    const h = makeHarness();
    h.spawn({ intervalMs: 60_000, quietAfterMs: 30_000 });
    // 无输出推进 90s：t=30k/60k quiet；t=90k 时 interval（30k 重设后 +60k）
    // 与 quiet（60k 重设后 +30k）同刻到期——旧实现在此进入 remain=0 零延迟风暴。
    await vi.advanceTimersByTimeAsync(90_000);
    await flushAggregation();
    expect(h.deliveries.length).toBe(3); // 旧 bug：风暴产生 100+ 条
    expect(h.deliveries.every((d) => d.text.includes('无新输出'))).toBe(true);
  });

  it('interval 到期触发周期汇报并互重置计时', async () => {
    const h = makeHarness();
    const { child, id } = h.spawn({ intervalMs: 60_000, quietAfterMs: 120_000 });

    // t=20_000 有输出（携带增量供汇报）；quiet 窗口 140_000，不与 interval 竞争。
    await vi.advanceTimersByTimeAsync(20_000);
    child.stdout.emit('data', 'tick\n');
    await vi.advanceTimersByTimeAsync(40_000); // t=60_000：interval 到期
    await flushAggregation();
    expect(h.deliveries.length).toBe(1);
    expect(h.deliveries[0].text).toContain(`${id} 运行中`);
    expect(h.deliveries[0].text).toContain('周期汇报');
    expect(h.deliveries[0].text).toContain('tick');

    // 互重置：节拍触发后 interval 从 60_000 重新计 60s → 120_000 到期。
    await vi.advanceTimersByTimeAsync(59_748); // t=119_999：未到期
    expect(h.deliveries.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1); // t=120_000
    await flushAggregation();
    expect(h.deliveries.length).toBe(2);
  });

  it('输出只重置静默计时，不动 interval 墙钟', async () => {
    const h = makeHarness();
    const { child } = h.spawn({ intervalMs: 60_000, quietAfterMs: 60_000 });

    // t=20_000 输出：quiet 从 80_000 起算；interval 墙钟 60_000 不受影响。
    await vi.advanceTimersByTimeAsync(20_000);
    child.stdout.emit('data', 'out-1\n');
    await vi.advanceTimersByTimeAsync(40_000); // t=60_000：interval 照期触发
    await flushAggregation();
    expect(h.deliveries.length).toBe(1);
    expect(h.deliveries[0].text).toContain('周期汇报');
    expect(h.deliveries[0].text).toContain('out-1');
  });

  it('静默到期触发"无新输出"汇报', async () => {
    const h = makeHarness();
    h.spawn({ intervalMs: 300_000, quietAfterMs: 30_000 });

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAggregation();
    expect(h.deliveries.length).toBe(1);
    expect(h.deliveries[0].text).toContain('无新输出');
  });

  it('readyPattern 匹配发一次性就绪并重置节奏', async () => {
    const h = makeHarness();
    const { child } = h.spawn({ intervalMs: 300_000, quietAfterMs: 300_000, readyPattern: 'listening on' });

    child.stdout.emit('data', 'server listening on :5173\n');
    await flushAggregation();
    expect(h.deliveries.length).toBe(1);
    expect(h.deliveries[0].text).toContain('已就绪');

    // 再次匹配不再发。
    child.stderr.emit('data', 'still listening on\n');
    await vi.advanceTimersByTimeAsync(301_000);
    await flushAggregation();
    const readyCount = h.deliveries.filter((d) => d.text.includes('已就绪')).length;
    expect(readyCount).toBe(1);
  });
});

describe('事件优先级：exit 赢', () => {
  it('close 在节拍触发同时到达时只发完成通知', async () => {
    const h = makeHarness();
    const { child, id } = h.spawn({ intervalMs: 60_000, quietAfterMs: 60_000 });

    // t=15_000 输出推迟 quiet（75_000），让 close 与 interval(60_000) 赛点重合。
    await vi.advanceTimersByTimeAsync(15_000);
    child.stdout.emit('data', 'final\n');
    await vi.advanceTimersByTimeAsync(44_999); // t=59_999
    child.emit('close', 0); // 终态先到：节拍回调晚 1ms 到达时 status 已非 running
    await vi.advanceTimersByTimeAsync(2); // t=60_001：interval 已被 clear
    await flushAggregation();
    expect(h.deliveries.length).toBe(1);
    expect(h.deliveries[0].text).toContain(`${id} 已完成`);
    expect(h.deliveries[0].text).toContain('退出码: 0');
  });

  it('kill 预置 killed 终态，后续 close 不再产生通知', async () => {
    const h = makeHarness();
    const { child, id } = h.spawn({});
    expect(h.registry.kill(id)).toBe(true);
    child.emit('close', 1);
    await flushAggregation();
    expect(h.deliveries.length).toBe(1);
    expect(h.deliveries[0].text).toContain(`${id} 已终止`);
  });
});

describe('clamp 与继承', () => {
  it('模型声明低于下限时被 clamp', () => {
    const h = makeHarness();
    const { id } = h.spawn({ intervalMs: 1_000, quietAfterMs: 500 });
    const s = h.registry.snapshot(h.registry.get(id)!);
    expect(s.pace.intervalMs).toBe(BG_MIN_INTERVAL_MS);
    expect(s.pace.quietAfterMs).toBe(BG_MIN_QUIET_MS);
    expect(s.inheritedPace).toBe(false);
  });

  it('inherited（前台转后台）允许低于下限', () => {
    const h = makeHarness();
    const { id } = h.spawn({ intervalMs: 20_000, quietAfterMs: 20_000, inherited: true });
    const s = h.registry.snapshot(h.registry.get(id)!);
    expect(s.pace.intervalMs).toBe(20_000);
    expect(s.inheritedPace).toBe(true);
  });

  it('tune 只能调宽（clamp 下限兜住继承的紧凑节奏）', () => {
    const h = makeHarness();
    const { id } = h.spawn({ intervalMs: 20_000, quietAfterMs: 20_000, inherited: true });
    const pace = h.registry.tune(id, { intervalMs: 1_000 });
    expect(pace!.intervalMs).toBe(BG_MIN_INTERVAL_MS);
  });
});

describe('通知管线', () => {
  it('250ms 窗口内多任务通知合并为一条投递', async () => {
    const h = makeHarness();
    const a = h.spawn({});
    const b = h.spawn({});

    // 两任务先后终态（同窗口）：合并为一条 user-turn。
    a.child.emit('close', 0);
    b.child.emit('close', 1);
    await flushAggregation();
    expect(h.deliveries.length).toBe(1);
    expect(h.deliveries[0].text).toContain(a.id);
    expect(h.deliveries[0].text).toContain(b.id);
    expect(h.deliveries[0].text).toContain('---');
  });

  it('投递失败滞留，bg_status 补发后清空', async () => {
    let fail = true;
    const h = makeHarness({ deliverImpl: async () => {
      if (fail) throw new Error('viewer down');
    } });
    const { child, id } = h.spawn({ intervalMs: 60_000, quietAfterMs: 30_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    await flushAggregation();
    expect(h.deliveries.length).toBe(0);

    const task = h.registry.get(id)!;
    expect(task.unsent.length).toBeGreaterThan(0);

    fail = false;
    const view = h.registry.statusView(task);
    expect(view.unsentCatchUp.length).toBeGreaterThan(0);
    expect(h.registry.statusView(task).unsentCatchUp.length).toBe(0);
    child.emit('close', 0);
  });

  it('exit 通知带尾部输出', async () => {
    const h = makeHarness();
    const { child, id } = h.spawn({});
    child.stdout.emit('data', 'build step 1 done\n');
    child.emit('close', 0);
    await flushAggregation();
    expect(h.deliveries[0].text).toContain('build step 1 done');
    expect(h.deliveries[0].sourceRef).toBe(id);
  });

  it('节拍汇报不推进增量游标（通知摘要与 bg_status 游标解耦）', async () => {
    const h = makeHarness();
    const { child } = h.spawn({ intervalMs: 60_000, quietAfterMs: 120_000 });

    // 输出超通知摘要上限（2000 字符）：节拍通知只带尾部，但游标不前进。
    await vi.advanceTimersByTimeAsync(20_000);
    child.stdout.emit('data', `${'x'.repeat(3_000)}\n`);
    await vi.advanceTimersByTimeAsync(40_000); // t=60_000：interval 触发
    await flushAggregation();
    expect(h.deliveries.length).toBe(1);
    expect(h.deliveries[0].text).toContain('…'); // 截断标记（尾部摘要）

    const task = h.registry.get('bg-1')!;
    const v = h.registry.statusView(task);
    expect(v.newOutput.length).toBe(3_001); // bg_status 仍能看到全部新输出
  });

  it('writeStdin 写入与失败路径', () => {
    const h = makeHarness();
    const { child, id } = h.spawn({});
    expect(h.registry.writeStdin(id, 'y\n')).toBe(true);
    expect((child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual(['y\n']);
    child.emit('close', 0);
    expect(h.registry.writeStdin(id, 'y\n')).toBe(false); // 已终态
    expect(h.registry.writeStdin('bg-999', 'y\n')).toBe(false); // 不存在
  });

  it('tune 的 quiet 分支同样 clamp 且重置计时', async () => {
    const h = makeHarness();
    const { id } = h.spawn({ intervalMs: 300_000, quietAfterMs: 300_000, inherited: true });
    const pace = h.registry.tune(id, { quietAfterMs: 1_000 });
    expect(pace!.quietAfterMs).toBe(BG_MIN_QUIET_MS);
    expect(pace!.intervalMs).toBe(300_000); // 未指定项保持
  });

  it('dispose：清理全部任务，pending 通知摊还 unsent', () => {
    const h = makeHarness();
    h.spawn({});
    h.spawn({});
    // killAll 为每个任务产生终止通知（进聚合窗口）；dispose 清 flush timer
    // 并把 pending 摊还各任务 unsent——不静默消失。
    h.registry.dispose();
    const list = h.registry.list();
    expect(list.every((t) => t.status !== 'running')).toBe(true);
    for (const s of list) {
      const task = h.registry.get(s.id)!;
      expect(task.unsent.length).toBe(1);
      expect(task.unsent[0]).toContain('已终止');
    }
  });

  it('配额满时 register 抛错（调用方需 kill 刚 spawn 的进程）', () => {
    const h = makeHarness();
    for (let i = 0; i < 8; i++) h.spawn();
    const child = makeFakeChild();
    expect(() => h.registry.register(child, {
      command: 'overflow', workdir, intervalMs: 60_000, quietAfterMs: 30_000,
    })).toThrow(/上限/);
  });
});

describe('ring buffer 与增量游标', () => {
  it('超限时保尾部、游标被 clamp', () => {
    const h = makeHarness();
    const { child, id } = h.spawn({});
    const task = h.registry.get(id)!;

    const chunk = 'x'.repeat(64 * 1024);
    child.stdout.emit('data', chunk);
    child.stdout.emit('data', chunk);
    child.stdout.emit('data', chunk);
    child.stdout.emit('data', chunk);
    child.stdout.emit('data', chunk); // 320KB > 256KB

    expect(task.totalBytes).toBe(5 * 64 * 1024);
    expect(task.droppedBytes).toBeGreaterThan(0);
    // 从 0 读：起点被 clamp 到 droppedBytes。
    const read = h.registry.readSince(task, 0);
    expect(read.clamped).toBe(true);
    expect(Buffer.byteLength(read.text, 'utf-8')).toBeLessThanOrEqual(BG_RING_BUFFER_MAX_BYTES);
  });

  it('bg_status 增量语义：只取上次查看以来的新输出', () => {
    const h = makeHarness();
    const { child } = h.spawn({});
    const task = h.registry.get('bg-1')!;

    child.stdout.emit('data', 'first\n');
    const v1 = h.registry.statusView(task);
    expect(v1.newOutput).toBe('first\n');

    child.stdout.emit('data', 'second\n');
    const v2 = h.registry.statusView(task);
    expect(v2.newOutput).toBe('second\n');
  });
});

describe('配额与保留', () => {
  it('running 上限 8，done 保留 5', async () => {
    const h = makeHarness();
    const children: FakeChild[] = [];
    for (let i = 0; i < 8; i++) {
      children.push(h.spawn().child);
    }
    expect(() => h.spawn()).toThrow(/上限/);

    // 全部完成 → done 淘汰到 5。
    for (const c of children) c.emit('close', 0);
    await flushAggregation();
    expect(h.registry.list().length).toBe(5);
  });
});

describe('bg_wait', () => {
  it('超时返回 null（不是失败），终态返回任务', async () => {
    const h = makeHarness();
    const { child, id } = h.spawn({});

    // fake timers 下 wait 的超时定时器不会自动走：先取 promise，推进时间再 await。
    const t1p = h.registry.wait(id, 50);
    await vi.advanceTimersByTimeAsync(51);
    const t1 = await t1p;
    expect(t1).toBeNull();

    child.emit('close', 0);
    const t2 = await h.registry.wait(id, 50); // 已终态：立即返回
    expect(t2).not.toBeNull();
    expect(t2!.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// 真实子进程（交互语义）
// ---------------------------------------------------------------------------

describe('前台语义（真实子进程）', () => {
  it('超时转后台：进程不被打断，收养进 registry', async () => {
    vi.useRealTimers();
    const h = makeHarness();
    const controller = new AbortController();
    const runP = runForegroundWithBudget(
      {
        command: 'sleep 5; echo late',
        workdir,
        bashPath: findGitBashPath()!,
        resourceRoot: process.cwd(),
        budgetMs: 500,
        signal: controller.signal,
        termination: () => 'timeout',
      },
      (child, pre) => h.registry.register(child, {
        command: 'sleep 5; echo late',
        workdir,
        intervalMs: 500,
        quietAfterMs: 500,
        inherited: true,
        preOutput: pre.stdout,
      }),
    );
    await new Promise((r) => setTimeout(r, 600));
    controller.abort();
    const run = await runP;

    expect(run.adoptedTask).not.toBeNull();
    expect(run.outcome.kind).toBe('aborted');
    const s = h.registry.snapshot(run.adoptedTask!);
    expect(s.status).toBe('running');
    expect(s.pace.intervalMs).toBe(500);
    expect(s.inheritedPace).toBe(true);

    // 清理：kill 收养任务。
    h.registry.kill(run.adoptedTask!.id);
    await new Promise((r) => setTimeout(r, 200));
  }, 10_000);

  it('用户打断：kill + terminated（ADR-0005 语义不变）', async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    const runP = runForegroundWithBudget(
      {
        command: 'sleep 5',
        workdir,
        bashPath: findGitBashPath()!,
        resourceRoot: process.cwd(),
        budgetMs: 30_000,
        signal: controller.signal,
        termination: () => 'user',
      },
      () => {
        throw new Error('user interrupt should not adopt');
      },
    );
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const run = await runP;

    expect(run.adoptedTask).toBeNull();
    expect(run.outcome.kind).toBe('terminated');
  }, 10_000);
});

describe('工具集成（真实子进程）', () => {
  it('bash_bg 捕获窗内完成 → 直返结果', async () => {
    vi.useRealTimers();
    const h = makeHarness();
    const tool = createBashBgTool('test bg', {
      workdir,
      bashPath: findGitBashPath()!,
      resourceRoot: process.cwd(),
      registry: h.registry,
    });
    const out = await tool.execute!({ command: 'echo fast-done', intervalSec: 60, quietAfterSec: 30 } as never, {} as never);
    expect(out).toContain('fast-done');
    expect(out).toContain('捕获窗');
    expect(h.registry.list().length).toBe(0);
  }, 10_000);

  it('bash 前台超预算 → 工具返回转后台文案且进程存活', async () => {
    vi.useRealTimers();
    const h = makeHarness();
    const tool = createShellCommandTool('test bash', {
      workdir,
      bashPath: findGitBashPath()!,
      resourceRoot: process.cwd(),
      timeoutMs: 400,
      registry: h.registry,
    });
    const controller = new AbortController();
    // 直调 execute 没有 executor 计时：模拟 executor 400ms 后超时 abort。
    setTimeout(() => controller.abort(), 400).unref?.();
    const out = (await tool.execute!(
      { command: 'sleep 3; echo survived' } as never,
      { signal: controller.signal, timeoutMs: 400, termination: () => 'timeout' } as never,
    )) as string;

    expect(out).toContain('已转为后台任务');
    // 命令回显含 'survived' 字样是预期的；断言的是命令输出未随返回（独立行出现）。
    expect(out).not.toMatch(/^survived$/m);
    const list = h.registry.list();
    expect(list.length).toBe(1);
    expect(list[0].status).toBe('running');
    expect(list[0].inheritedPace).toBe(true);

    h.registry.kill(list[0].id);
    await new Promise((r) => setTimeout(r, 200));
  }, 10_000);
});

afterEach(() => {
  // 真实子进程用例后兜底清理（防止孤儿进程影响后续用例）。
});

process.on('exit', () => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
});
