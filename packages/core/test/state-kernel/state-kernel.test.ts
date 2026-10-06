/**
 * state-kernel 内核测试（ADR-0021 阶段 1 / PR-F1，实施计划 §7 矩阵全量）。
 *
 * 内核是纯函数转换求值器：定义期静态校验四类 + reduce 求值语义
 * （from 匹配 / guards / 终态 / to 三态 / effect 顺序 / lifecycleEvent /
 * ctx 时钟 / 幂等）。本文件只测内核本身，不涉及任何外壳迁移。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  defineStateMachine,
  reduce,
} from '../../src/core/state-kernel/index.js';
import type {
  Guard,
  KernelCtx,
  KernelLifecycleEvent,
  ReduceResult,
  StateMachineDef,
  TransitionDef,
} from '../../src/core/state-kernel/index.js';

/** 宿主实体样例：status 只是其中一个字段，伴随字段由 effect 维护。 */
interface TaskRecord {
  id: string;
  status: string;
  assignee: string | null;
  attempts: number;
  note: string | null;
  seenStatus?: string;
  lifecycleEvents: KernelLifecycleEvent[];
}

function makeRecord(status: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    status,
    assignee: null,
    attempts: 0,
    note: null,
    lifecycleEvents: [],
    ...overrides,
  };
}

/** 共享状态词汇：done 为终态。 */
function makeDef(transitions: TransitionDef<TaskRecord>[]): StateMachineDef<TaskRecord> {
  return {
    id: 'task-machine',
    statusField: 'status',
    states: {
      draft: {},
      active: {},
      paused: {},
      blocked: {},
      done: { terminal: true },
    },
    transitions,
  };
}

/** 记录守卫调用顺序与实参（record.id / event.type / ctx.now）的探针守卫。 */
function spyGuard(
  label: string,
  calls: string[],
  verdict: boolean | { code: string } = true,
): Guard<TaskRecord> {
  return (record, event, ctx) => {
    calls.push(`${label}:${record.id}:${event.type}:${ctx.now()}`);
    return verdict;
  };
}

describe('defineStateMachine 定义期静态校验', () => {
  it('合法定义原样返回，不抛错', () => {
    const def = makeDef([
      { event: 'start', from: ['draft'], to: 'active' },
      { event: 'pause', from: ['active'], to: 'paused' },
      { event: 'close', from: '*', to: 'done' },
    ]);
    expect(() => defineStateMachine(def)).not.toThrow();
    expect(defineStateMachine(def)).toBe(def);
  });

  it('from 引用未声明状态 → 抛错', () => {
    const def = makeDef([{ event: 'start', from: ['draft', 'ghost'], to: 'active' }]);
    expect(() => defineStateMachine(def)).toThrowError(/undeclared state "ghost"/);
  });

  it('to 引用未声明状态（静态字符串）→ 抛错', () => {
    const def = makeDef([{ event: 'start', from: ['draft'], to: 'limbo' }]);
    expect(() => defineStateMachine(def)).toThrowError(/undeclared state "limbo"/);
  });

  it('终态出现在显式 from → 抛错', () => {
    const def = makeDef([{ event: 'reopen', from: ['draft', 'done'], to: 'active' }]);
    expect(() => defineStateMachine(def)).toThrowError(/terminal state "done"/);
  });

  it('同 event 下显式 from 集合重叠 → 抛错', () => {
    const def = makeDef([
      { event: 'start', from: ['draft', 'paused'], to: 'active' },
      { event: 'start', from: ['paused', 'blocked'], to: 'done' },
    ]);
    expect(() => defineStateMachine(def)).toThrowError(/overlapping "from" on state "paused"/);
  });

  it('"*" 与显式 from 同 event 并存（歧义）→ 抛错', () => {
    const def = makeDef([
      { event: 'start', from: '*', to: 'active' },
      { event: 'start', from: ['draft'], to: 'blocked' },
    ]);
    expect(() => defineStateMachine(def)).toThrowError(/overlapping "from"/);
  });

  it('同 event 出现两个 "*" → 抛错', () => {
    const def = makeDef([
      { event: 'start', from: '*', to: 'active' },
      { event: 'start', from: '*', to: 'blocked' },
    ]);
    expect(() => defineStateMachine(def)).toThrowError(/overlapping "from" on state "draft"/);
  });

  it('不同 event 共享相同 from 是合法的', () => {
    const def = makeDef([
      { event: 'start', from: ['draft'], to: 'active' },
      { event: 'block', from: ['draft'], to: 'blocked' },
    ]);
    expect(() => defineStateMachine(def)).not.toThrow();
  });
});

describe('reduce：from 匹配', () => {
  const machine = defineStateMachine(
    makeDef([
      { event: 'start', from: ['draft'], to: 'active' },
      { event: 'wake', from: ['paused', 'blocked'], to: 'active' },
      { event: 'ping', from: '*', to: 'active' },
    ]),
  );

  it('单值 from 命中：transitioned 并写入目标状态', () => {
    const record = makeRecord('draft');
    const result = reduce(machine, record, { type: 'start' }, { now: () => 1 });
    expect(result).toEqual({
      type: 'transitioned',
      from: 'draft',
      to: 'active',
      lifecycleEvent: { type: 'start', status: 'active', at: 1 },
    });
    expect(record.status).toBe('active');
  });

  it('数组 from 命中：任一源状态都可触发', () => {
    for (const status of ['paused', 'blocked']) {
      const record = makeRecord(status);
      const result = reduce(machine, record, { type: 'wake' });
      expect(result.type).toBe('transitioned');
      expect(result.type === 'transitioned' && result.from).toBe(status);
      expect(record.status).toBe('active');
    }
  });

  it('"*" 命中任意已声明的非终态', () => {
    const record = makeRecord('paused');
    expect(reduce(machine, record, { type: 'ping' }).type).toBe('transitioned');
    expect(record.status).toBe('active');
  });

  it('from 不含当前状态 → unhandled，record 不变', () => {
    const record = makeRecord('active', { attempts: 3, note: 'keep' });
    expect(reduce(machine, record, { type: 'start' })).toEqual({ type: 'unhandled' });
    expect(record).toEqual(makeRecord('active', { attempts: 3, note: 'keep' }));
  });

  it('event 无任何转换 → unhandled', () => {
    const record = makeRecord('draft');
    expect(reduce(machine, record, { type: 'nonexistent' })).toEqual({ type: 'unhandled' });
    expect(record.status).toBe('draft');
  });

  it('"*" 不匹配状态词汇之外的值：未声明 status → unhandled（不静默换状态）', () => {
    const record = makeRecord('ghost');
    expect(reduce(machine, record, { type: 'ping' })).toEqual({ type: 'unhandled' });
    expect(record.status).toBe('ghost');
  });
});

describe('reduce：guards', () => {
  function makeGuardMachine(guards: Guard<TaskRecord>[]) {
    return defineStateMachine(
      makeDef([{ event: 'launch', from: ['draft'], guards, to: 'active' }]),
    );
  }

  it('全部通过：按书写顺序求值，实参 (record, event, ctx) 完整注入', () => {
    const calls: string[] = [];
    const machine = makeGuardMachine([
      spyGuard('g1', calls),
      spyGuard('g2', calls),
      spyGuard('g3', calls),
    ]);
    const record = makeRecord('draft');
    const result = reduce(machine, record, { type: 'launch' }, { now: () => 7 });
    expect(result.type).toBe('transitioned');
    expect(calls).toEqual(['g1:task-1:launch:7', 'g2:task-1:launch:7', 'g3:task-1:launch:7']);
    expect(record.status).toBe('active');
  });

  it('首败即停：结构化拒绝携带 code，后续守卫不再求值，record 不变', () => {
    const calls: string[] = [];
    const machine = makeGuardMachine([
      spyGuard('g1', calls),
      spyGuard('g2', calls, { code: 'throttled' }),
      spyGuard('g3', calls),
    ]);
    const record = makeRecord('draft', { attempts: 2 });
    expect(reduce(machine, record, { type: 'launch' }, { now: () => 1 })).toEqual({
      type: 'rejected',
      reason: 'throttled',
    });
    expect(calls).toEqual(['g1:task-1:launch:1', 'g2:task-1:launch:1']);
    expect(record).toEqual(makeRecord('draft', { attempts: 2 }));
  });

  it('boolean false → rejected 无 code（reason "guard"）', () => {
    const calls: string[] = [];
    const machine = makeGuardMachine([spyGuard('gate', calls, false), spyGuard('next', calls)]);
    expect(reduce(machine, makeRecord('draft'), { type: 'launch' })).toEqual({
      type: 'rejected',
      reason: 'guard',
    });
    expect(calls.length).toBe(1);
  });

  it('守卫抛错向上传播（内核不捕获）', () => {
    const machine = makeGuardMachine([
      () => {
        throw new Error('identity unavailable');
      },
    ]);
    expect(() => reduce(machine, makeRecord('draft'), { type: 'launch' })).toThrowError(
      /identity unavailable/,
    );
  });
});

describe('reduce：终态保护', () => {
  it('终态上的任何事件 → rejected terminal，guards 不再求值，record 不变', () => {
    const calls: string[] = [];
    const machine = defineStateMachine(
      makeDef([
        { event: 'close', from: ['draft'], guards: [spyGuard('close-guard', calls)], to: 'done' },
        { event: 'seal', from: '*', guards: [spyGuard('seal-guard', calls)], to: 'done' },
      ]),
    );
    const closed = makeRecord('done', { note: 'final' });
    expect(reduce(machine, closed, { type: 'close' })).toEqual({
      type: 'rejected',
      reason: 'terminal',
    });
    expect(reduce(machine, closed, { type: 'seal' })).toEqual({
      type: 'rejected',
      reason: 'terminal',
    });
    expect(calls).toEqual([]);
    expect(closed).toEqual(makeRecord('done', { note: 'final' }));
  });

  it('终态 + 未定义事件仍优先 rejected terminal（而非 unhandled）', () => {
    const machine = defineStateMachine(makeDef([{ event: 'close', from: ['draft'], to: 'done' }]));
    expect(reduce(machine, makeRecord('done'), { type: 'nonexistent' })).toEqual({
      type: 'rejected',
      reason: 'terminal',
    });
  });
});

describe('reduce：to 三态', () => {
  it('静态字符串：写入目标状态', () => {
    const machine = defineStateMachine(
      makeDef([{ event: 'start', from: ['draft'], to: 'active' }]),
    );
    const record = makeRecord('draft');
    const result = reduce(machine, record, { type: 'start' }, { now: () => 1 });
    expect(result.type).toBe('transitioned');
    if (result.type === 'transitioned') {
      expect(result.from).toBe('draft');
      expect(result.to).toBe('active');
    }
    expect(record.status).toBe('active');
  });

  it('函数式：依求值时的 record 决定目标', () => {
    const machine = defineStateMachine(
      makeDef([
        {
          event: 'start',
          from: ['draft'],
          to: (record) => (record.assignee ? 'active' : 'paused'),
        },
      ]),
    );
    const assigned = makeRecord('draft', { assignee: 'alice' });
    const unassigned = makeRecord('draft', { assignee: null });
    const r1 = reduce(machine, assigned, { type: 'start' });
    const r2 = reduce(machine, unassigned, { type: 'start' });
    expect(r1.type === 'transitioned' && r1.to).toBe('active');
    expect(r2.type === 'transitioned' && r2.to).toBe('paused');
  });

  it('to 返回 null：status 不变，result.to 与 lifecycleEvent.status 取原状态，effect 照常执行', () => {
    const machine = defineStateMachine(
      makeDef([
        {
          event: 'clear',
          from: ['paused'],
          to: () => null,
          effect: (record) => {
            record.note = 'cleared';
          },
        },
      ]),
    );
    const record = makeRecord('paused', { note: 'stale' });
    const result = reduce(machine, record, { type: 'clear' }, { now: () => 5 });
    expect(result).toEqual({
      type: 'transitioned',
      from: 'paused',
      to: 'paused',
      lifecycleEvent: { type: 'clear', status: 'paused', at: 5 },
    });
    expect(record.status).toBe('paused');
    expect(record.note).toBe('cleared');
  });
});

describe('reduce：effect 与求值顺序', () => {
  it('effect 变异在结果中可见；payload 与 to 函数可见 effect 前的 record', () => {
    const machine = defineStateMachine(
      makeDef([
        {
          event: 'commit',
          from: ['draft'],
          to: (record) => (record.note === 'clean' ? 'active' : 'blocked'),
          eventPayload: (record) => ({ noteAtPayload: record.note }),
          effect: (record) => {
            record.note = 'by-effect';
          },
        },
      ]),
    );
    const record = makeRecord('draft', { note: 'clean' });
    const result = reduce(machine, record, { type: 'commit' }, { now: () => 2 });
    // to 在 effect 之前求值：看到的还是 'clean' → active（而非 blocked）
    expect(result.type === 'transitioned' && result.to).toBe('active');
    // payload 同样在 effect 之前求值
    expect(result.type === 'transitioned' && result.lifecycleEvent.noteAtPayload).toBe('clean');
    // effect 变异在返回后可见
    expect(record.note).toBe('by-effect');
    expect(record.status).toBe('active');
  });

  it('effect 可见转换前的旧 status', () => {
    const machine = defineStateMachine(
      makeDef([
        {
          event: 'start',
          from: ['draft'],
          to: 'active',
          effect: (record) => {
            record.seenStatus = record.status;
          },
        },
      ]),
    );
    const record = makeRecord('draft');
    reduce(machine, record, { type: 'start' });
    expect(record.seenStatus).toBe('draft');
    expect(record.status).toBe('active');
  });

  it('无 effect：仅换 status，其余字段不动，lifecycleEvent 照常生成', () => {
    const machine = defineStateMachine(
      makeDef([{ event: 'start', from: ['draft'], to: 'active' }]),
    );
    const record = makeRecord('draft', { attempts: 4, note: 'keep', assignee: 'bob' });
    const before = structuredClone(record);
    const result = reduce(machine, record, { type: 'start' }, { now: () => 9 });
    expect(result.type).toBe('transitioned');
    expect(record.status).toBe('active');
    expect({ ...record, status: 'draft' }).toEqual(before);
  });
});

describe('reduce：lifecycleEvent', () => {
  it('字段完整（type/status/at）且 payload 展开为同级字段', () => {
    const machine = defineStateMachine(
      makeDef([
        {
          event: 'handoff_failed',
          from: '*',
          to: 'blocked',
          eventPayload: () => ({ reason: 'crash', stage: 'unknown' }),
        },
      ]),
    );
    const result = reduce(machine, makeRecord('paused'), { type: 'handoff_failed' }, { now: () => 4242 });
    expect(result.type === 'transitioned' && result.lifecycleEvent).toEqual({
      type: 'handoff_failed',
      status: 'blocked',
      at: 4242,
      reason: 'crash',
      stage: 'unknown',
    });
  });

  it('ctx.now 注入：at 取注入时钟值', () => {
    const machine = defineStateMachine(
      makeDef([{ event: 'start', from: ['draft'], to: 'active' }]),
    );
    const ctx: KernelCtx = { now: () => 424242 };
    const result = reduce(machine, makeRecord('draft'), { type: 'start' }, ctx);
    expect(result.type === 'transitioned' && result.lifecycleEvent.at).toBe(424242);
  });

  it('缺省 ctx：at 取 Date.now', () => {
    vi.useFakeTimers();
    try {
      const fixedAt = 1_760_000_000_000;
      vi.setSystemTime(fixedAt);
      const machine = defineStateMachine(
        makeDef([{ event: 'start', from: ['draft'], to: 'active' }]),
      );
      const result = reduce(machine, makeRecord('draft'), { type: 'start' });
      expect(result.type === 'transitioned' && result.lifecycleEvent.at).toBe(fixedAt);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reduce：statusField 校验', () => {
  const machine = defineStateMachine(makeDef([{ event: 'start', from: ['draft'], to: 'active' }]));

  it('record 缺 statusField 字段 → 求值期显式抛错（不留 undefined 静默路径）', () => {
    const bare = {
      id: 'task-1',
      assignee: null,
      attempts: 0,
      note: null,
      lifecycleEvents: [],
    } as unknown as TaskRecord;
    expect(() => reduce(machine, bare, { type: 'start' })).toThrowError(
      /task-machine.*missing status field "status"/,
    );
  });

  it('status 为 null 或非字符串 → 同样显式报错', () => {
    const nullStatus = makeRecord('draft', { status: null as unknown as string });
    expect(() => reduce(machine, nullStatus, { type: 'start' })).toThrowError(
      /missing status field "status"/,
    );
    const numericStatus = makeRecord('draft', { status: 1 as unknown as string });
    expect(() => reduce(machine, numericStatus, { type: 'start' })).toThrowError(
      /missing status field "status".*got number/,
    );
  });

  it('statusField 可配置：状态可承载在任意字段名上', () => {
    interface PhaseRecord {
      phase: string;
      label: string;
    }
    const phaseMachine = defineStateMachine<PhaseRecord>({
      id: 'phase-machine',
      statusField: 'phase',
      states: { todo: {}, doing: {}, archived: { terminal: true } },
      transitions: [{ event: 'pick', from: ['todo'], to: 'doing' }],
    });
    const record: PhaseRecord = { phase: 'todo', label: 'sample' };
    const result = reduce(phaseMachine, record, { type: 'pick' }, { now: () => 3 });
    expect(result.type === 'transitioned' && result.from).toBe('todo');
    expect(record.phase).toBe('doing');
    expect(record.label).toBe('sample');
  });
});

describe('reduce：幂等 / 无内部状态', () => {
  it('同一输入重复求值，结果与 record 终态逐位一致', () => {
    const machine = defineStateMachine(
      makeDef([
        {
          event: 'start',
          from: ['draft'],
          to: 'active',
          effect: (record) => {
            record.attempts += 1;
          },
          eventPayload: (record) => ({ attempts: record.attempts }),
        },
      ]),
    );
    const ctx: KernelCtx = { now: () => 9999 };
    const seed = makeRecord('draft', { attempts: 6 });
    let firstResult: ReduceResult | undefined;
    let firstRecord: TaskRecord | undefined;
    for (let i = 0; i < 5; i++) {
      const clone = structuredClone(seed);
      const result = reduce(machine, clone, { type: 'start' }, ctx);
      if (i === 0) {
        firstResult = result;
        firstRecord = clone;
        continue;
      }
      expect(result).toEqual(firstResult);
      expect(clone).toEqual(firstRecord);
    }
    expect(firstResult).toEqual({
      type: 'transitioned',
      from: 'draft',
      to: 'active',
      lifecycleEvent: { type: 'start', status: 'active', at: 9999, attempts: 6 },
    });
    expect(firstRecord?.attempts).toBe(7);
  });
});
