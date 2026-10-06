/**
 * state-kernel 类型定义（ADR-0021 阶段 1，PR-F1）。
 *
 * 内核是纯函数转换求值器：声明式转换表 + 守卫求值 + 终态保护 +
 * lifecycle 事件生成。不持有存储、不做 I/O、无隐藏状态——持久化
 * 事务与观测桥接都是外壳（WorkThread store.update / CallArbiter
 * inspection 通道）的职责。
 */

/**
 * 内核事件：`type` 标识事件名（与 TransitionDef.event 匹配），
 * 其余字段由宿主自定义（在类型上体现为未知负载字段）。
 */
export interface KernelEvent {
  type: string;
  [key: string]: unknown;
}

/** 时钟注入：stale 判定等时间依赖经此进入，测试可控；缺省 Date.now。 */
export interface KernelCtx {
  now(): number;
}

/** 守卫结构化拒绝：code 供外壳重建精确错误（内核不知道 HTTP status / 错误工厂）。 */
export interface GuardRejection {
  code: string;
}

/**
 * 守卫：返回 true 放行；false 拒绝（reason 'guard'，无 code）；
 * `{ code }` 拒绝并携带 code。抛错向上传播（不做任何捕获）。
 */
export type Guard<R, E extends KernelEvent = KernelEvent> = (
  record: R,
  event: E,
  ctx: KernelCtx,
) => boolean | GuardRejection;

/** 状态声明。terminal: true = 终态，其上任何事件都 rejected 'terminal'。 */
export interface StateDef {
  terminal?: boolean;
}

/** lifecycle 事件：与 WorkThread 落盘格式（type / status / at）保持兼容。 */
export interface KernelLifecycleEvent {
  type: string;
  status: string;
  at: number;
  [key: string]: unknown;
}

export interface TransitionDef<R, E extends KernelEvent = KernelEvent> {
  /** 事件名，与 event.type 匹配。 */
  event: string;
  /** 源状态集合；'*' = 全部已声明的非终态。 */
  from: string[] | '*';
  /** 顺序求值，首败即停。 */
  guards?: Guard<R, E>[];
  /** 目标状态：静态值 / 函数式（返回 null = status 不变）。 */
  to: string | ((record: R, event: E, ctx: KernelCtx) => string | null);
  /** 就地修改 record 伴随字段。在 to / payload 求值之后、status 写入与 lifecycle 事件生成之前执行。 */
  effect?: (record: R, event: E, ctx: KernelCtx) => void;
  /** lifecycle 事件 payload，在 effect 之前求值（可见 effect 前的 record）。 */
  eventPayload?: (record: R, event: E, ctx: KernelCtx) => object;
}

export interface StateMachineDef<R, E extends KernelEvent = KernelEvent> {
  id: string;
  /** record 上承载状态的字段名。 */
  statusField: string;
  states: Record<string, StateDef>;
  transitions: TransitionDef<R, E>[];
}

/**
 * reduce 结果三态：
 * - transitioned：转换发生（to 函数返回 null 时 to = 原状态）
 * - rejected：reason = 'terminal' | 'guard'（boolean false 守卫，无 code）| 守卫 code
 * - unhandled：无匹配转换，throw 还是 no-op 由外壳决定
 */
export type ReduceResult =
  | { type: 'transitioned'; from: string; to: string; lifecycleEvent: KernelLifecycleEvent }
  | { type: 'rejected'; reason: string }
  | { type: 'unhandled' };
