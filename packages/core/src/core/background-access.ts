/**
 * 通用后台接入（ADR-0031）—— 待唤醒工作登记、一次性待命、唤醒通知衔接。
 *
 * 这是各领域后台能力（Bash 进程、Coder 监视……）与框架挂起事实层
 * （PendingWakeup / registerPendingWorkProvider / StepFinish 决策边界）之间的
 * 薄衔接层。它只收拢通用时序，不感知任何领域语义（进程输出、线程状态、
 * 监控周期都不是这里的事）：
 *
 * - 登记与释放：registerWork 返回可释放句柄；同 id 重复登记显式拒绝（领域
 *   幂等复用应持有既有句柄，不静默覆盖）。未释放的登记随 attachAgent 向
 *   所属 Agent 申报 pending-work（ADR-0019），回合自然结束时据此改判
 *   suspended。注册 key 为实例唯一，多个接入（shell + coder）互不覆盖，
 *   PendingWakeup.source 保持领域命名空间不变。
 * - 一次性待命：requestStandby 登记显式待命意图，读即消费；消费要求存在
 *   真实待唤醒或待投递的工作（hasPendingWork）——不能空待命。本模块独立于
 *   Hook——由消费者显式驱动：CallStart 时 consume 清残留，StepFinish 决策
 *   边界（当前工具调用完整返回后）consume 命中则让出轮次。旧的关键词
 *   订阅等持续性观察不产生待命意图，不会误停后续轮次。
 * - 唤醒通知：只接受已登记工作的提交通知；接收者是登记时捕获的归属会话
 *   （创建时固定，不回退"当前会话"）。排队 → 同接收者聚合 → 按接收者分组
 *   → 交给注入的投递器，事件身份（eventId，randomUUID 派生，跨 runtime
 *   唯一）与工作身份（workIds）分离。投递失败保留未送达事实
 *   （consumeUndelivered 补取）。忙时投递只经注入投递器进入宿主输入队列，
 *   本模块不重入主循环。
 * - 终态衔接：terminal 通知成功投递后，且该工作不存在任何其余未送达事实
 *   （其余批次在途 / 滞留）时才释放登记——pending 必须保到全部事实被交付
 *   或主动补取，不提前判真完成。同工作待发通知的替换（exit 赢）是领域
 *   声明的语义（replacesPending）：由领域保证终态文本自含被替换内容，本
 *   模块不假设终态文本包含周期增量或输出。
 * - dispose：经宿主返回的 identity-safe 注销器真正摘除 agent 申报回调，
 *   并清除待命意图。不丢弃未送达事实、不终止已提交通知的投递（工作可能
 *   比接入实例活得久），也不 kill 任何业务资源——是否停止业务由领域自决。
 *
 * 本模块不轮询、不定时汇报、不维护统一任务表、不提供统一 kill、不实现
 * 通知持久化。没有可用投递器时构造即显式失败——不存在永不唤醒的
 * "后台成功"。
 */

import { randomUUID } from 'node:crypto';
import type { PendingWakeup } from './lifecycle.js';

/**
 * 一次唤醒通知投递事件。
 *
 * 事件身份与工作身份分离：`eventId` 是本次通知事件的稳定唯一身份（宿主
 * 可安全用作幂等键——同一事件重投保持同一 id，不同批次必不同，同工作的
 * 后续通知不会撞既有事件）；`workIds` 携带本批次涉及的全部工作 id。宿主
 * 如何呈现/持久化这组事实由适配器决定，本模块不解释。
 *
 * `sessionId` 为接收者会话（登记时捕获）；未声明会话的宿主（单 runtime
 * 用法）收到 undefined，行为与"不携带会话字段"的现状一致。
 */
export interface WakeupDeliveryEvent {
  /** 通知事件身份（稳定唯一；幂等键语义见上）。 */
  eventId: string;
  /** 合并后的通知文本。 */
  text: string;
  /** 本批次相关的工作 id（按通知顺序去重）。 */
  workIds: string[];
  /** 接收者会话（null/undefined = 未声明）。 */
  sessionId?: string | null;
}

/**
 * 唤醒投递器（宿主注入）：把一条已按接收者分组的通知事件投给对应接收者。
 * resolve 即视为送达；reject / 超时 / 非 2xx 由实现侧抛出，接入层据此保留
 * 未送达事实。HTTP 等具体 IO 由领域适配器实现，本模块不做网络。
 */
export type WakeupDeliver = (event: WakeupDeliveryEvent) => Promise<void>;

/**
 * 挂接目标的最小结构（Agent 满足此形状即可，避免反向依赖具体类）。
 *
 * `registerPendingWorkProvider` 必须返回 identity-safe 注销器：仅当表中
 * 当前 provider 仍是本次注册的那一个时才移除。接入实例 dispose / 重复
 * attachAgent / 更换 host 时经它真正摘除回调，不留残留闭包。
 */
export interface PendingWorkHost {
  registerPendingWorkProvider(source: string, provider: () => PendingWakeup[]): () => void;
}

export interface BackgroundWorkSpec {
  /** 工作标识（申报 id 与通知 workId 同源；同 id 重复登记显式拒绝）。 */
  id: string;
  /** 人可读的一行摘要（如命令行、监视目标）。 */
  summary: string;
  /**
   * 所属会话（登记时捕获，此后不变）。缺省继承接入实例声明；显式传入
   * （含 null）以登记方为准——多会话共享底层资源时归属不得被改写。
   */
  sessionId?: string | null;
}

export interface BackgroundWorkHandle {
  readonly id: string;
  /** 登记时捕获的接收者会话（null = 未声明）。 */
  readonly sessionId: string | null;
  /** 释放登记：不再申报 pending-work。业务资源与观察器由领域自行释放。 */
  release(): void;
}

export interface BackgroundNoticeSpec {
  /** 通知目标（必须是已登记且未清账的工作 id）。 */
  workId: string;
  /** 通知文本（领域已格式化；本模块不解释内容）。 */
  text: string;
  /**
   * 终态通知：投递成功且该工作无其余未送达事实后释放登记（不提前判真
   * 完成）。同一工作的终态通知只认第一次（重复提交忽略）。
   */
  terminal?: boolean;
  /**
   * 入队时替换同工作待发的非终态通知（exit 赢）。替换语义由领域声明：
   * 领域需保证本次文本自含被替换通知的信息（Bash 的终态文本携带全量
   * 尾部输出即属此类）；本模块不替领域做这个假设。
   */
  replacesPending?: boolean;
}

export interface BackgroundAccessOptions {
  /** 申报命名空间（PendingWakeup.source，如 'shell'；本模块不解释语义）。 */
  source: string;
  /** 实例归属会话缺省值（缺省/空 = 未声明，宿主按单 runtime 现状路由）。 */
  sessionId?: string | null;
  /** 注入投递器（必需）。缺失时构造抛错——必须显式失败，不静默降级。 */
  deliver: WakeupDeliver;
  /** 同接收者通知聚合窗口（毫秒）；缺省 0 = 立即投递。 */
  aggregationWindowMs?: number;
  /**
   * 工作登记释放时回调（可选，幂等触发）：领域用于联动自身簿记——如
   * Bash 任务表在终态通知成功投递后才具备裁剪条件。回调抛错被吞。
   */
  onWorkRelease?: (workId: string) => void;
}

interface WorkRecord {
  id: string;
  summary: string;
  sessionId: string | null;
  released: boolean;
  /** 已提交终态通知：全部未送达事实交付/补取后释放（不提前判真完成）。 */
  finished: boolean;
}

interface NoticeRecord {
  workId: string;
  text: string;
  sessionId: string | null;
  terminal: boolean;
  /** queued → inflight →（移除=已送达 | unsent）。unsent 只能经补取移除。 */
  state: 'queued' | 'inflight' | 'unsent';
}

let instanceSeq = 0;

export class BackgroundAccess {
  private readonly _source: string;
  private readonly _declaredSessionId: string | null;
  private readonly _deliver: WakeupDeliver;
  private readonly _aggregationWindowMs: number;
  private readonly _onWorkRelease: ((workId: string) => void) | null;
  private readonly _works = new Map<string, WorkRecord>();
  private readonly _notices: NoticeRecord[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 一次性待命意图（读即消费；CallStart 清残留、StepFinish 安全边界消费）。 */
  private _standbyOnce = false;
  private _disposed = false;
  /** 实例唯一注册 key：多接入互不覆盖 agent 的 pending-work provider 表。 */
  private readonly _regKey: string;
  /** attachAgent 捕获的注销器（dispose / 重挂时真正移除 provider）。 */
  private _providerDisposer: (() => void) | null = null;

  constructor(opts: BackgroundAccessOptions) {
    if (typeof opts.deliver !== 'function') {
      throw new Error(
        `[background-access] source=${opts.source} 缺少可用的唤醒投递器（deliver）：` +
        '没有投递器的后台接入永远无法唤醒，必须显式失败而不是静默降级',
      );
    }
    this._source = opts.source;
    this._declaredSessionId = typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
    this._deliver = opts.deliver;
    this._aggregationWindowMs =
      typeof opts.aggregationWindowMs === 'number' && Number.isFinite(opts.aggregationWindowMs) && opts.aggregationWindowMs > 0
        ? opts.aggregationWindowMs
        : 0;
    this._onWorkRelease = typeof opts.onWorkRelease === 'function' ? opts.onWorkRelease : null;
    this._regKey = `${opts.source}#bg-access-${++instanceSeq}`;
  }

  // -- 工作登记 ---------------------------------------------------------------

  /**
   * 登记待唤醒工作：未释放前随 provider 申报 pending-work。同 id 重复登记
   * 显式拒绝（幂等复用应持有既有 handle，静默覆盖会让旧 handle 误释放新
   * 登记）。handle 释放只摘除申报，不影响任何业务资源。
   */
  registerWork(spec: BackgroundWorkSpec): BackgroundWorkHandle {
    if (this._works.has(spec.id)) {
      throw new Error(
        `[background-access] 工作 ${spec.id} 已登记（source=${this._source}）：` +
        '幂等复用请持有既有 handle，不得重复登记覆盖',
      );
    }
    const record: WorkRecord = {
      id: spec.id,
      summary: spec.summary,
      sessionId: spec.sessionId === undefined
        ? this._declaredSessionId
        : (spec.sessionId || null),
      released: false,
      finished: false,
    };
    this._works.set(record.id, record);
    return {
      id: record.id,
      sessionId: record.sessionId,
      release: () => {
        this._releaseWork(record);
      },
    };
  }

  /** 幂等释放：摘除申报、联动领域回调、清理无滞留事实的记录。 */
  private _releaseWork(record: WorkRecord): void {
    if (record.released) return;
    record.released = true;
    this._pruneWork(record.id);
    if (this._onWorkRelease) {
      try {
        this._onWorkRelease(record.id);
      } catch { /* 领域簿记失败不影响通用时序 */ }
    }
  }

  /**
   * 回合结束时刻仍待唤醒的工作快照（ADR-0019 事实层）。已释放的不申报；
   * 终态但事实尚未全部交付的仍然申报——不提前判真完成。
   */
  pendingWakeups(): PendingWakeup[] {
    const wakeups: PendingWakeup[] = [];
    for (const work of this._works.values()) {
      if (work.released) continue;
      wakeups.push({ source: this._source, id: work.id, summary: work.summary });
    }
    return wakeups;
  }

  /** 是否存在真实待唤醒（未释放登记）或待投递（未送达事实）的工作。 */
  hasPendingWork(): boolean {
    for (const work of this._works.values()) {
      if (!work.released) return true;
    }
    return this._notices.length > 0;
  }

  // -- 通知衔接 ---------------------------------------------------------------

  /**
   * 提交一条唤醒通知：只接受已登记工作（未登记的通知没有 pending 事实
   * 支撑，显式拒绝而不是隐式继承会话投递）。接收者是登记时捕获的归属
   * 会话，创建时固定。忙时不重入：只经投递器进入宿主输入队列。
   */
  submitNotice(spec: BackgroundNoticeSpec): void {
    const work = this._works.get(spec.workId);
    if (!work) {
      throw new Error(
        `[background-access] 工作 ${spec.workId} 未登记（source=${this._source}），拒绝提交通知：` +
        '通知必须挂靠登记工作，否则没有 pending 事实与接收者归属',
      );
    }
    if (spec.terminal) {
      if (work.finished) return; // 终态幂等：同工作只认第一次终态通知
      work.finished = true;
    }
    if (spec.replacesPending) {
      // 领域声明的 exit 赢：移除同工作待发的非终态通知（领域已保证本次
      // 文本自含其信息）。已在投递中的无法撤回（窗口极小，接受）。
      for (let i = this._notices.length - 1; i >= 0; i--) {
        const n = this._notices[i]!;
        if (n.workId === spec.workId && n.state === 'queued' && !n.terminal) {
          this._notices.splice(i, 1);
        }
      }
    }
    this._notices.push({
      workId: spec.workId,
      text: spec.text,
      sessionId: work.sessionId,
      terminal: spec.terminal === true,
      state: 'queued',
    });
    this._scheduleFlush();
  }

  /**
   * 是否存在未送达事实（排队 / 投递中 / 投递失败滞留）。领域用它在清理
   * 任务表时保住"结果还没交到模型手里"的工作（不被保留上限裁掉）。
   */
  hasUndelivered(workId: string): boolean {
    return this._notices.some((n) => n.workId === workId);
  }

  /**
   * 补取路径：取走并清空该工作的滞留通知文本（如 bg_status 的
   * unsentCatchUp）。终态工作在全部滞留清空后释放登记——此后不再申报
   * pending，回合可自然完成。
   */
  consumeUndelivered(workId: string): string[] {
    const texts: string[] = [];
    for (let i = this._notices.length - 1; i >= 0; i--) {
      const n = this._notices[i]!;
      if (n.workId === workId && n.state === 'unsent') {
        texts.unshift(n.text);
        this._notices.splice(i, 1);
      }
    }
    if (texts.length > 0) {
      const work = this._works.get(workId);
      if (work) this._settleFinished(work);
    }
    return texts;
  }

  /**
   * 事实结算钩子（每条通知落定后调用）：
   * - 已释放（如主动取消等待）：最后一条事实（in-flight/滞留）落定后清账，
   *   released 记录不滞留 works 表；
   * - 已提交终态且无任何其余未送达事实：释放登记（pending 保到全部事实
   *   交付，不提前判真完成）。
   */
  private _settleFinished(work: WorkRecord): void {
    if (work.released) {
      this._pruneWork(work.id);
      return;
    }
    if (!work.finished) return;
    if (this._notices.some((n) => n.workId === work.id)) return;
    this._releaseWork(work);
  }

  private _scheduleFlush(): void {
    if (this._flushTimer) return;
    const delay = this._aggregationWindowMs;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this._flush();
    }, delay);
    this._flushTimer.unref?.();
  }

  private async _flush(): Promise<void> {
    const batch = this._notices.filter((n) => n.state === 'queued');
    if (batch.length === 0) return;
    for (const n of batch) n.state = 'inflight';
    // 按实际接收者分组：不同会话不合并为同一次投递（接收者是登记时捕获
    // 的事实，不是"当前会话"）。未声明会话的归入同一默认组（单 runtime 现状）。
    const groups = new Map<string, NoticeRecord[]>();
    for (const n of batch) {
      const key = n.sessionId ?? '';
      const group = groups.get(key);
      if (group) group.push(n);
      else groups.set(key, [n]);
    }
    for (const [key, group] of groups) {
      const text = group.map((n) => n.text).join('\n\n---\n\n');
      // 事件身份按序去重：聚合不丢任何工作引用，也不重复携带。
      const workIds: string[] = [];
      for (const n of group) {
        if (!workIds.includes(n.workId)) workIds.push(n.workId);
      }
      const event: WakeupDeliveryEvent = {
        eventId: `${this._source}-evt-${randomUUID()}`,
        text,
        workIds,
        sessionId: key === '' ? undefined : key,
      };
      try {
        await this._deliver(event);
      } catch {
        // 投递失败：滞留为未送达事实，consumeUndelivered 补取（信任底线：
        // 不把投递失败伪装成已通知）。
        for (const n of group) n.state = 'unsent';
        continue;
      }
      for (const n of group) {
        const idx = this._notices.indexOf(n);
        if (idx !== -1) this._notices.splice(idx, 1);
        const work = this._works.get(n.workId);
        if (work) this._settleFinished(work);
      }
    }
  }

  /** 释放后且无未送达事实的登记记录从表内清掉（事实由 notices 承载）。 */
  private _pruneWork(workId: string): void {
    const work = this._works.get(workId);
    if (!work) return;
    if (work.released && !this._notices.some((n) => n.workId === workId)) {
      this._works.delete(workId);
    }
  }

  // -- 一次性待命 -------------------------------------------------------------

  /**
   * 登记一次性待命意图（显式请求，如 bg_tune then=standby、bg_watch 订阅
   * 即停）：不设定时器、不产生消息。消费契约由消费者驱动——CallStart 清
   * 残留（防极端路径误伤后续回合），StepFinish 安全边界消费命中则让出轮次。
   * 消费时要求存在真实待唤醒/待投递工作：没有可等的事实就不空待命
   * （flag 一并清除，不残留到后续轮次）。
   */
  requestStandby(): void {
    if (this._disposed) return;
    this._standbyOnce = true;
  }

  /** 消费待命意图：存在待命标记且有真实可等工作时返回 true 并清除。 */
  consumeStandbyRequest(): boolean {
    const wanted = this._standbyOnce;
    this._standbyOnce = false;
    return wanted && this.hasPendingWork();
  }

  // -- Agent 挂接与销毁 ---------------------------------------------------------

  /**
   * 向所属 Agent 申报 pending-work provider（幂等：重复挂接 / 更换 host
   * 时先经旧注销器摘除，不积累闭包）。注册 key 实例唯一，多个接入
   * （shell + coder）并存互不覆盖；PendingWakeup.source 保持领域命名空间。
   * dispose 经注销器真正移除注册。
   */
  attachAgent(agent: PendingWorkHost): void {
    if (this._disposed) {
      throw new Error('[background-access] 实例已销毁，不能再挂接 agent（请创建新实例）');
    }
    this._detachProvider();
    this._providerDisposer = agent.registerPendingWorkProvider(this._regKey, () => this.pendingWakeups());
  }

  /** 摘除当前 agent 申报注册（幂等）。 */
  private _detachProvider(): void {
    if (!this._providerDisposer) return;
    const disposer = this._providerDisposer;
    this._providerDisposer = null;
    try {
      disposer();
    } catch { /* 注销失败不影响事实保留 */ }
  }

  /**
   * 销毁接入实例：经注销器真正移除 agent 申报回调并清除待命意图。不丢弃
   * 未送达事实、不终止已提交通知的投递——工作可能比接入实例活得久（如
   * 共享任务表上的进程），通知与补取继续可用；业务资源（进程、连接、
   * 监视目标）是否停止由领域自决，本模块不 kill。
   */
  dispose(): void {
    this._disposed = true;
    this._standbyOnce = false;
    this._detachProvider();
  }
}
