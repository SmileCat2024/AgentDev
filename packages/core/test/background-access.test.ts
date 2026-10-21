/**
 * 通用后台接入（ADR-0031）core 侧测试
 *
 * 覆盖：
 * - 构造契约：缺投递器显式失败；注册 key 实例唯一、多接入互不覆盖；
 *   PendingWakeup.source 保持领域命名空间；identity-safe disposer 消费
 * - 真实 Agent 接线：attach→申报→dispose 真实摘除注册（不残留回调）
 * - 工作登记：申报 / 释放 / 幂等释放；同 id 重复登记显式拒绝；
 *   终态未投递不提前判真完成
 * - 通知衔接：只接受已登记工作；同接收者聚合合并、按接收者分组不串话、
 *   接收者创建时捕获、事件身份（randomUUID 派生）与工作身份分离、
 *   workIds 完整去重
 * - 终态优先（exit 赢）：replacesPending 由领域声明，未声明不替换
 * - 投递失败：滞留未送达事实、补取释放；终态送达但同工作仍有滞留事实时
 *   不提前释放；运行中任务的滞留补取不释放
 * - in-flight 算未送达（trim 保护窗口）
 * - 一次性待命：读即消费、要求真实可等工作（不空待命）、dispose 清除
 * - dispose：注销申报回调、通知投递与补取保留、不重入 agent 主循环
 *
 * 计时纪律：全部使用 fake timers（advanceTimersByTimeAsync 推过 flush 定时
 * 节点并等 async 链落定），不做真实时间轮询。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../src/core/agent.js';
import { BackgroundAccess } from '../src/core/background-access.js';
import type {
  LLMClient,
  LLMResponse,
  Message,
  Tool,
} from '../src/core/types.js';
import type { PendingWakeup } from '../src/core/lifecycle.js';
import type {
  PendingWorkHost,
  WakeupDeliver,
  WakeupDeliveryEvent,
} from '../src/core/background-access.js';

/** 即答 LLM（真实 Agent 接线测试用）。 */
class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

function makeHost(): PendingWorkHost & {
  providers: Map<string, () => PendingWakeup[]>;
  disposedKeys: string[];
  onCall: ReturnType<typeof vi.fn>;
} {
  const providers = new Map<string, () => PendingWakeup[]>();
  const disposedKeys: string[] = [];
  return {
    providers,
    disposedKeys,
    onCall: vi.fn(),
    // identity-safe 注销器契约（与真实 Agent.registerPendingWorkProvider 对齐）：
    // 仅当前 provider 仍是本次注册的那一个时才移除。
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

function collectDeliveries(): { events: WakeupDeliveryEvent[]; deliver: WakeupDeliver } {
  const events: WakeupDeliveryEvent[] = [];
  const deliver: WakeupDeliver = async (event) => {
    events.push(event);
  };
  return { events, deliver };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 立即投递（聚合窗口 0）：推过 flush 定时器并等 async deliver 链落定。 */
async function flushNow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** 聚合窗口 250ms：推过窗口并等 async deliver 链落定。 */
async function flushAggregation(): Promise<void> {
  await vi.advanceTimersByTimeAsync(251);
}

describe('构造契约', () => {
  it('缺少投递器时构造显式失败（不存在永不唤醒的后台成功）', () => {
    expect(() => new BackgroundAccess({ source: 'shell', deliver: undefined as never })).toThrow(/投递器/);
  });

  it('注册 key 实例唯一：多个接入并存互不覆盖，PendingWakeup.source 保持领域命名空间', () => {
    const host = makeHost();
    const { deliver } = collectDeliveries();
    const shell = new BackgroundAccess({ source: 'shell', deliver });
    const coder = new BackgroundAccess({ source: 'coder', deliver });
    shell.attachAgent(host);
    coder.attachAgent(host);
    expect(host.providers.size).toBe(2);

    shell.registerWork({ id: 'bg-1', summary: 'npm test' });
    coder.registerWork({ id: 'exec-1', summary: 'thread-a' });

    const shellWakeups = [...host.providers.values()] // 顺序无关：逐个调用
      .map((p) => p())
      .find((items) => items.some((w) => w.id === 'bg-1'))!;
    expect(shellWakeups).toEqual([{ source: 'shell', id: 'bg-1', summary: 'npm test' }]);
    const coderWakeups = [...host.providers.values()]
      .map((p) => p())
      .find((items) => items.some((w) => w.id === 'exec-1'))!;
    expect(coderWakeups).toEqual([{ source: 'coder', id: 'exec-1', summary: 'thread-a' }]);
  });

  it('同一实例重复 attachAgent 幂等（先注销旧注册再登记，不积累闭包）', () => {
    const host = makeHost();
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.attachAgent(host);
    const key = [...host.providers.keys()][0]!;
    access.attachAgent(host);
    expect(host.providers.size).toBe(1);
    expect(host.disposedKeys).toEqual([key]); // 旧注册被 identity-safe 注销
  });

  it('更换 host 重挂：先摘旧 host 注册，新 host 生效，不残留', () => {
    const hostA = makeHost();
    const hostB = makeHost();
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.attachAgent(hostA);
    access.attachAgent(hostB);
    expect(hostA.providers.size).toBe(0); // 旧 host 注册已摘除
    expect(hostB.providers.size).toBe(1);
    access.registerWork({ id: 'w1', summary: 'c1' });
    expect([...hostB.providers.values()][0]!()).toEqual([{ source: 'shell', id: 'w1', summary: 'c1' }]);
  });

  it('多接入多 host 并存：各自注销互不影响', () => {
    const hostA = makeHost();
    const hostB = makeHost();
    const { deliver } = collectDeliveries();
    const shell = new BackgroundAccess({ source: 'shell', deliver });
    const coder = new BackgroundAccess({ source: 'coder', deliver });
    shell.attachAgent(hostA);
    coder.attachAgent(hostA);
    coder.attachAgent(hostB); // coder 迁移到 hostB，shell 在 hostA 不受影响
    expect(hostA.providers.size).toBe(1);
    expect(hostB.providers.size).toBe(1);
    shell.dispose();
    expect(hostA.providers.size).toBe(0);
    expect(hostB.providers.size).toBe(1); // coder 仍在
  });

  it('dispose 后 attachAgent 抛错（接入失败显式）', () => {
    const host = makeHost();
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.dispose();
    expect(() => access.attachAgent(host)).toThrow(/销毁/);
  });

  it('identity 语义：同 key 新注册覆盖后，旧 disposer 不误删新注册', () => {
    const host = makeHost();
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.attachAgent(host);
    const key = [...host.providers.keys()][0]!;
    access.attachAgent(host); // 新注册覆盖旧注册（同 key）
    expect(host.providers.size).toBe(1); // 新注册仍在
    expect(host.disposedKeys).toEqual([key]); // 被注销的是旧注册
  });
});

describe('真实 Agent 接线（identity-safe disposer）', () => {
  it('attach→申报→dispose：provider 从真实 Agent 表移除，销毁不残留回调', () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });

    access.attachAgent(agent);
    access.registerWork({ id: 'bg-1', summary: 'npm run build' });
    expect(agent.collectPendingWakeups()).toEqual([
      { source: 'shell', id: 'bg-1', summary: 'npm run build' },
    ]);

    access.dispose();
    expect(agent.collectPendingWakeups()).toEqual([]); // 真实摘除，非仅标记失效
    // 注销后可重新挂接新实例（Agent 表不再有旧条目）。
    const access2 = new BackgroundAccess({ source: 'shell', deliver });
    access2.attachAgent(agent);
    access2.registerWork({ id: 'bg-2', summary: 'npm test' });
    expect(agent.collectPendingWakeups()).toEqual([
      { source: 'shell', id: 'bg-2', summary: 'npm test' },
    ]);
    access2.dispose();
    expect(agent.collectPendingWakeups()).toEqual([]);
  });

  it('回合挂起判定走真实 Agent：登记未释放的工作让自然完成改判 suspended', async () => {
    const agent = new Agent({ llm: new ImmediateLLM(), maxTurns: 1 });
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.attachAgent(agent);
    access.registerWork({ id: 'bg-1', summary: 'npm run build' });

    const outcome = await agent.onCallDetailed('build it');
    expect(outcome.reason).toBe('suspended');
    expect(outcome.pendingWakeups).toEqual([
      { source: 'shell', id: 'bg-1', summary: 'npm run build' },
    ]);
  });
});

describe('工作登记与申报', () => {
  it('登记后申报 pending-work，release 后不再申报（幂等）', () => {
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    const work = access.registerWork({ id: 'bg-1', summary: 'npm run build' });
    expect(access.pendingWakeups()).toEqual([{ source: 'shell', id: 'bg-1', summary: 'npm run build' }]);
    work.release();
    work.release();
    expect(access.pendingWakeups()).toEqual([]);
  });

  it('同 id 重复登记显式拒绝（旧 handle 不得误释放新登记）', () => {
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    const work = access.registerWork({ id: 'bg-1', summary: 'first' });
    expect(() => access.registerWork({ id: 'bg-1', summary: 'second' })).toThrow(/已登记/);
    // 旧 handle 语义不变：释放的是它登记的那份。
    work.release();
    expect(access.pendingWakeups()).toEqual([]);
  });

  it('登记继承实例声明会话；显式传入（含 null）以登记方为准', () => {
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', sessionId: 'sess-default', deliver });
    expect(access.registerWork({ id: 'a', summary: 'a' }).sessionId).toBe('sess-default');
    expect(access.registerWork({ id: 'b', summary: 'b', sessionId: 'sess-b' }).sessionId).toBe('sess-b');
    expect(access.registerWork({ id: 'c', summary: 'c', sessionId: null }).sessionId).toBeNull();
  });
});

describe('通知衔接', () => {
  it('未登记工作的提交通知显式拒绝（不隐式继承会话投递）', () => {
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', sessionId: 'sess-x', deliver });
    expect(() => access.submitNotice({ workId: 'ghost', text: 'n' })).toThrow(/未登记/);
  });

  it('聚合窗口 0 时下个 tick 即投递，不同 tick 各自成批', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'bg-1', summary: 'cmd-1' });
    access.submitNotice({ workId: 'bg-1', text: 'n1' });
    await flushNow();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ text: 'n1', workIds: ['bg-1'], sessionId: undefined });
    expect(events[0]!.eventId).toMatch(/^shell-evt-[0-9a-f-]{36}$/);
    access.submitNotice({ workId: 'bg-1', text: 'n2' });
    await flushNow();
    expect(events.length).toBe(2);
  });

  it('同接收者窗口内聚合为一条，workIds 完整携带全部相关任务', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({
      source: 'shell',
      sessionId: 'sess-1',
      deliver,
      aggregationWindowMs: 250,
    });
    access.registerWork({ id: 'bg-1', summary: 'cmd-1' });
    access.registerWork({ id: 'bg-2', summary: 'cmd-2' });
    access.submitNotice({ workId: 'bg-1', text: 'n1' });
    access.submitNotice({ workId: 'bg-2', text: 'n2' });
    await flushAggregation();
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe('n1\n\n---\n\nn2');
    expect(events[0]!.workIds).toEqual(['bg-1', 'bg-2']);
    expect(events[0]!.sessionId).toBe('sess-1');
  });

  it('同工作多条通知聚合时 workIds 去重，事件身份仍唯一', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver, aggregationWindowMs: 250 });
    access.registerWork({ id: 'bg-1', summary: 'cmd-1' });
    access.submitNotice({ workId: 'bg-1', text: 'ready-ish' });
    access.submitNotice({ workId: 'bg-1', text: 'periodic' });
    await flushAggregation();
    expect(events.length).toBe(1);
    expect(events[0]!.workIds).toEqual(['bg-1']);
    expect(events[0]!.text).toContain('ready-ish');
    expect(events[0]!.text).toContain('periodic');
  });

  it('不同接收者分组分别投递，各自带捕获的会话；未声明归默认组', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', sessionId: 'sess-now', deliver, aggregationWindowMs: 250 });
    access.registerWork({ id: 'a', summary: 'a', sessionId: 'sess-a' });
    access.registerWork({ id: 'b', summary: 'b', sessionId: 'sess-b' });
    access.registerWork({ id: 'c', summary: 'c', sessionId: null });
    access.submitNotice({ workId: 'a', text: 'ta' });
    access.submitNotice({ workId: 'b', text: 'tb' });
    access.submitNotice({ workId: 'c', text: 'tc' });
    await flushAggregation();
    expect(events.length).toBe(3);
    const byText = new Map(events.map((e) => [e.text, e]));
    expect(byText.get('ta')).toMatchObject({ workIds: ['a'], sessionId: 'sess-a' });
    expect(byText.get('tb')).toMatchObject({ workIds: ['b'], sessionId: 'sess-b' });
    expect(byText.get('tc')).toMatchObject({ workIds: ['c'], sessionId: undefined });
    // 三个接收者绝不合并为一次投递（末任务决定全批的旧串话根因）。
    expect(events.every((e) => ['ta', 'tb', 'tc'].includes(e.text))).toBe(true);
  });

  it('接收者在通知创建时捕获（继承登记归属），不回退实例当前声明', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', sessionId: 'sess-new', deliver, aggregationWindowMs: 250 });
    access.registerWork({ id: 'old', summary: 'old-cmd', sessionId: 'sess-old' });
    access.submitNotice({ workId: 'old', text: 'done-text' });
    await flushAggregation();
    expect(events.length).toBe(1);
    expect(events[0]!.sessionId).toBe('sess-old');
  });

  it('事件身份跨批次稳定唯一：同任务两次通知拿到不同 eventId', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'bg-1', summary: 'cmd-1' });
    access.submitNotice({ workId: 'bg-1', text: 'p1' });
    await flushNow();
    access.submitNotice({ workId: 'bg-1', text: 'p2' });
    await flushNow();
    expect(events.length).toBe(2);
    expect(events[0]!.eventId).toBeTruthy();
    expect(events[1]!.eventId).toBeTruthy();
    expect(events[0]!.eventId).not.toBe(events[1]!.eventId);
    expect(events[0]!.workIds).toEqual(['bg-1']);
    expect(events[1]!.workIds).toEqual(['bg-1']);
  });

  it('replacesPending 由领域声明：声明时替换同工作待发周期通知（exit 赢）', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver, aggregationWindowMs: 250 });
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.registerWork({ id: 'w2', summary: 'c2' });
    access.submitNotice({ workId: 'w1', text: 'w1-periodic' });
    access.submitNotice({ workId: 'w2', text: 'w2-periodic' });
    access.submitNotice({ workId: 'w1', text: 'w1-terminal', terminal: true, replacesPending: true });
    await flushAggregation();
    expect(events.length).toBe(1);
    const event = events[0]!;
    expect(event.text).toContain('w2-periodic');
    expect(event.text).toContain('w1-terminal');
    expect(event.text).not.toContain('w1-periodic'); // 被终态替换，未投递
    expect(event.workIds).toEqual(['w2', 'w1']);
  });

  it('未声明 replacesPending 的终态通知不替换待发通知（通用层不做输出全量假设）', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver, aggregationWindowMs: 250 });
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 'w1-periodic' });
    access.submitNotice({ workId: 'w1', text: 'w1-terminal', terminal: true });
    await flushAggregation();
    expect(events.length).toBe(1);
    expect(events[0]!.text).toContain('w1-periodic'); // 仍投递
    expect(events[0]!.text).toContain('w1-terminal');
  });

  it('同一工作重复终态通知只认第一次（幂等，不重复投递终态）', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 't1', terminal: true });
    access.submitNotice({ workId: 'w1', text: 't2', terminal: true });
    await flushNow();
    expect(events.length).toBe(1);
    expect(events[0]!.text).toBe('t1');
  });
});

describe('终态衔接与未送达事实', () => {
  it('终态通知成功投递且无其余滞留事实后释放登记（先完成后待命）', async () => {
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'w1', summary: 'c1' });
    expect(access.pendingWakeups()).toHaveLength(1);
    access.submitNotice({ workId: 'w1', text: 'done', terminal: true });
    await flushNow();
    expect(access.pendingWakeups()).toEqual([]);
  });

  it('终态通知投递失败：登记保留（不提前判真完成），补取后释放', async () => {
    let fail = true;
    let attempts = 0;
    const deliver: WakeupDeliver = async () => {
      attempts++;
      if (fail) throw new Error('viewer down');
    };
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 'final result', terminal: true });
    await flushNow(); // flush 已落定（deliver 抛错 → 滞留）
    expect(attempts).toBe(1);
    expect(access.hasUndelivered('w1')).toBe(true);
    expect(access.pendingWakeups()).toEqual([{ source: 'shell', id: 'w1', summary: 'c1' }]);

    fail = false;
    const texts = access.consumeUndelivered('w1');
    expect(texts).toEqual(['final result']);
    expect(access.pendingWakeups()).toEqual([]);
    expect(access.hasUndelivered('w1')).toBe(false);
  });

  it('终态送达但同工作仍有滞留事实：不提前释放，补取完成才释放', async () => {
    let attempts = 0;
    const deliver: WakeupDeliver = async (event) => {
      attempts++;
      if (attempts === 1) throw new Error('viewer down'); // 第一条投递失败
    };
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'w1', summary: 'c1' });
    // 第一条周期通知投递失败 → 滞留 unsent（等 flush 落定后再提交终态，
    // 两条分属不同批次）。
    access.submitNotice({ workId: 'w1', text: 'progress' });
    await flushNow();
    expect(attempts).toBe(1);
    // 终态通知随后成功投递：unsent 仍在，工作不得释放。
    access.submitNotice({ workId: 'w1', text: 'final', terminal: true });
    await flushNow();
    expect(attempts).toBe(2);
    expect(access.pendingWakeups()).toEqual([{ source: 'shell', id: 'w1', summary: 'c1' }]);

    // 补取滞留事实后（无其余未送达）才释放。
    expect(access.consumeUndelivered('w1')).toEqual(['progress']);
    expect(access.pendingWakeups()).toEqual([]);
  });

  it('运行中任务的周期通知滞留补取：清空事实但不释放登记', async () => {
    let fail = true;
    let attempts = 0;
    const deliver: WakeupDeliver = async () => {
      attempts++;
      if (fail) throw new Error('viewer down');
    };
    const access = new BackgroundAccess({ source: 'shell', deliver });
    const work = access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 'progress' });
    await flushNow();
    expect(attempts).toBe(1);

    expect(access.consumeUndelivered('w1')).toEqual(['progress']);
    expect(access.pendingWakeups()).toEqual([{ source: 'shell', id: 'w1', summary: 'c1' }]); // 仍在运行
    work.release();
    expect(access.pendingWakeups()).toEqual([]);
  });

  it('投递中（in-flight）算未送达：trim 保护窗口内不丢事实', async () => {
    let releaseDeliver: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseDeliver = resolve; });
    const deliver: WakeupDeliver = () => gate;
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 'n', terminal: true });
    // 同步推过 flush 定时器：deliver 挂起中，flush 停在 in-flight。
    vi.advanceTimersByTime(0);
    expect(releaseDeliver).not.toBeNull();
    expect(access.hasUndelivered('w1')).toBe(true); // 投递中

    releaseDeliver!();
    await gate; // 与 flush 同源：resolve 后 flush 收尾只差确定数量的微任务
    await Promise.resolve();
    expect(access.hasUndelivered('w1')).toBe(false);
  });

  it('释放后的登记不再申报，但其滞留事实仍可补取（不丢未送达）', async () => {
    let fail = true;
    let attempts = 0;
    const deliver: WakeupDeliver = async () => {
      attempts++;
      if (fail) throw new Error('viewer down');
    };
    const access = new BackgroundAccess({ source: 'shell', deliver });
    const work = access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 'progress' });
    await flushNow();
    expect(attempts).toBe(1);
    work.release();
    expect(access.pendingWakeups()).toEqual([]);
    expect(access.consumeUndelivered('w1')).toEqual(['progress']);
  });

  it('已释放工作在最后一条事实结算后清账（works 记录不残留）', async () => {
    // 行为探针：记录若残留，同 id 重新登记会抛"已登记"——无需诊断 API。
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    const work = access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 'n' });
    work.release(); // released + in-flight 事实 → 结算前暂不可裁
    await flushNow(); // 最后一条事实结算成功

    expect(() => access.registerWork({ id: 'w1', summary: 'again' })).not.toThrow();
  });

  it('已释放工作的滞留事实补取后同样清账', async () => {
    let fail = true;
    let attempts = 0;
    const deliver: WakeupDeliver = async () => {
      attempts++;
      if (fail) throw new Error('viewer down');
    };
    const access = new BackgroundAccess({ source: 'shell', deliver });
    const work = access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 'progress' });
    await flushNow();
    expect(attempts).toBe(1);
    work.release(); // released + unsent → 补取前暂不可裁
    expect(access.consumeUndelivered('w1')).toEqual(['progress']);

    expect(() => access.registerWork({ id: 'w1', summary: 'again' })).not.toThrow();
  });
});

describe('一次性待命', () => {
  it('读即消费；无真实可等工作时空待命不生效（消费返回 false）', async () => {
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    expect(access.consumeStandbyRequest()).toBe(false);

    // 无登记工作：盲登记不产生待命事实。
    access.requestStandby();
    expect(access.hasPendingWork()).toBe(false);
    expect(access.consumeStandbyRequest()).toBe(false);
    expect(access.consumeStandbyRequest()).toBe(false); // flag 已随消费清除

    // 有运行中工作：待命真实生效。
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.requestStandby();
    expect(access.consumeStandbyRequest()).toBe(true);
  });

  it('先完成后待命：唯一工作终态且事实交付后，待命消费不再生效', async () => {
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.requestStandby();
    access.submitNotice({ workId: 'w1', text: 'done', terminal: true });
    await flushNow();
    expect(access.pendingWakeups()).toEqual([]);
    // 等待目标已完成且结果已交付：不空待命（本轮继续，不永久等新事件）。
    expect(access.consumeStandbyRequest()).toBe(false);
  });

  it('dispose 清除待命意图，此后 requestStandby 不再生效', () => {
    const { deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.requestStandby();
    access.dispose();
    expect(access.consumeStandbyRequest()).toBe(false);
    access.requestStandby();
    expect(access.consumeStandbyRequest()).toBe(false);
  });
});

describe('dispose 与忙时投递', () => {
  it('dispose 后 provider 申报不再可达（真实摘除），通知投递与补取保留', async () => {
    const host = makeHost();
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    access.attachAgent(host);
    const work = access.registerWork({ id: 'w1', summary: 'c1' });
    access.dispose();
    expect(host.providers.size).toBe(0); // identity-safe disposer 真实摘除

    // 工作可能比接入实例活得久：已提交通知继续投递，未送达事实可补取。
    access.submitNotice({ workId: 'w1', text: 'late news' });
    await flushNow();
    expect(events.length).toBe(1);
    expect(access.consumeUndelivered('w1')).toEqual([]);
    work.release();
  });

  it('忙时投递只经注入投递器，不重入 agent 主循环', async () => {
    const { events, deliver } = collectDeliveries();
    const access = new BackgroundAccess({ source: 'shell', deliver });
    const host = makeHost();
    access.attachAgent(host);
    access.registerWork({ id: 'w1', summary: 'c1' });
    access.submitNotice({ workId: 'w1', text: 'while busy' });
    await flushNow();
    expect(events.length).toBe(1);
    expect(host.onCall).not.toHaveBeenCalled(); // 不直接重入 onCall
  });
});
