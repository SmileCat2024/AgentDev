/**
 * state-kernel — 状态机统一内核（ADR-0021 阶段 1，PR-F1）。
 *
 * 纯函数转换求值器：`defineStateMachine` 定义期静态校验 + `reduce`
 * 守卫求值 / 终态保护 / lifecycle 事件生成。严格同步（无 await、无
 * I/O、无隐藏状态），零依赖（不 import 框架内部模块与外部包）。
 * 存储事务、异步守卫、观测桥接都是外壳职责。
 *
 * reduce 求值顺序（实施计划 §2）：
 * 1. statusField 读取（缺失 / 非字符串 → 显式抛错，不留 undefined 静默路径）
 * 2. 终态检查 → rejected 'terminal'（guards 不再求值，优先于转换匹配）
 * 3. 转换匹配（event + from；'*' = 全部已声明的非终态）→ 无匹配 unhandled
 * 4. guards 顺序求值，首败即停
 * 5. to 解析与 eventPayload 求值（均可见 effect 前的 record）
 * 6. effect 执行（可见旧 status）
 * 7. status 写入（to 为 null 时不写）
 * 8. lifecycle 事件生成：{ type: 事件名, status, at: ctx.now(), ...payload }
 */

import type {
  KernelCtx,
  KernelEvent,
  KernelLifecycleEvent,
  ReduceResult,
  StateMachineDef,
} from './types.js';

export type {
  Guard,
  GuardRejection,
  KernelCtx,
  KernelEvent,
  KernelLifecycleEvent,
  ReduceResult,
  StateDef,
  StateMachineDef,
  TransitionDef,
} from './types.js';

function validateDef<R, E extends KernelEvent>(def: StateMachineDef<R, E>): void {
  const where = `state-kernel "${def.id ?? '<unnamed>'}"`;
  if (def.states === null || typeof def.states !== 'object') {
    throw new Error(`${where}: "states" must be a state map`);
  }
  if (!Array.isArray(def.transitions)) {
    throw new Error(`${where}: "transitions" must be an array`);
  }

  const stateNames = new Set(Object.keys(def.states));

  for (let i = 0; i < def.transitions.length; i++) {
    const transition = def.transitions[i];
    const at = `${where}: transitions[${i}] (event "${transition.event}")`;

    if (typeof transition.to === 'string' && !stateNames.has(transition.to)) {
      throw new Error(`${at}: "to" references undeclared state "${transition.to}"`);
    }
    if (transition.from !== '*') {
      if (!Array.isArray(transition.from)) {
        throw new Error(`${at}: "from" must be an array of state names or "*"`);
      }
      for (const state of transition.from) {
        if (!stateNames.has(state)) {
          throw new Error(`${at}: "from" references undeclared state "${state}"`);
        }
        if (def.states[state]?.terminal) {
          throw new Error(`${at}: "from" must not include terminal state "${state}"`);
        }
      }
    }
  }

  // 同 event 下 from 集合两两不允许重叠（'*' 展开为全部已声明的非终态，
  // 因此 '*' 与任何显式 from、'*' 与 '*' 并存都会在此报歧义）
  const nonTerminalStates = new Set(
    [...stateNames].filter((state) => !def.states[state]?.terminal),
  );
  const seenByEvent = new Map<string, Array<{ index: number; fromSet: Set<string> }>>();
  for (let i = 0; i < def.transitions.length; i++) {
    const transition = def.transitions[i];
    const fromSet = transition.from === '*' ? nonTerminalStates : new Set(transition.from);
    const group = seenByEvent.get(transition.event) ?? [];
    for (const previous of group) {
      for (const state of fromSet) {
        if (previous.fromSet.has(state)) {
          throw new Error(
            `${where}: event "${transition.event}" has overlapping "from" on state "${state}" ` +
              `(transitions[${previous.index}] vs transitions[${i}])`,
          );
        }
      }
    }
    group.push({ index: i, fromSet });
    seenByEvent.set(transition.event, group);
  }
}

/**
 * 定义期静态校验并返回状态机定义（原样返回，不复制不冻结）。
 *
 * 校验项：from/to 引用未声明状态、终态出现在显式 from、同 event 下
 * from 集合两两重叠（含 '*' 与显式并存的歧义）。reduce 不重复校验，
 * def 应来自本函数。
 */
export function defineStateMachine<R, E extends KernelEvent = KernelEvent>(
  def: StateMachineDef<R, E>,
): StateMachineDef<R, E> {
  validateDef(def);
  return def;
}

/**
 * 对 record 求值一次转换。严格同步纯函数：无 await、无 I/O、无内部
 * 状态（同一输入重复求值结果一致）；record 的变更只来自 effect 与
 * status 写入。guards / to / payload / effect 抛错一律向上传播。
 */
export function reduce<R, E extends KernelEvent = KernelEvent>(
  def: StateMachineDef<R, E>,
  record: R,
  event: E,
  ctx?: KernelCtx,
): ReduceResult {
  const clock: KernelCtx = ctx ?? { now: Date.now };
  const bag = record as Record<string, unknown>;
  const status = bag[def.statusField];
  if (typeof status !== 'string') {
    throw new Error(
      `state-kernel "${def.id}": record is missing status field "${def.statusField}" ` +
        `(expected a declared state name, got ${status === null ? 'null' : typeof status})`,
    );
  }

  // 终态保护优先于转换匹配与守卫求值
  if (def.states[status]?.terminal) {
    return { type: 'rejected', reason: 'terminal' };
  }

  const transition = def.transitions.find((candidate) => {
    if (candidate.event !== event.type) {
      return false;
    }
    if (candidate.from === '*') {
      // '*' = 全部已声明的非终态；终态已在上方拦截，这里只需已声明
      return Object.prototype.hasOwnProperty.call(def.states, status);
    }
    return candidate.from.includes(status);
  });
  if (!transition) {
    return { type: 'unhandled' };
  }

  if (transition.guards) {
    for (const guard of transition.guards) {
      const verdict = guard(record, event, clock);
      if (verdict === false) {
        return { type: 'rejected', reason: 'guard' };
      }
      if (verdict !== null && typeof verdict === 'object') {
        return { type: 'rejected', reason: verdict.code };
      }
    }
  }

  // to 与 payload 在 effect 之前求值（可见 effect 前的 record）
  const to =
    typeof transition.to === 'function' ? transition.to(record, event, clock) : transition.to;
  const payload = transition.eventPayload?.(record, event, clock);

  transition.effect?.(record, event, clock);

  if (typeof to === 'string') {
    (record as Record<string, unknown>)[def.statusField] = to;
  }

  // payload 展开在 type/status/at 之后，同名字段可覆盖（供宿主映射落盘事件名）
  const lifecycleEvent: KernelLifecycleEvent = {
    type: event.type,
    status: to ?? status,
    at: clock.now(),
    ...(payload ?? {}),
  };

  return { type: 'transitioned', from: status, to: to ?? status, lifecycleEvent };
}
