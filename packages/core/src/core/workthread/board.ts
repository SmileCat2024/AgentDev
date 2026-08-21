/**
 * WorkThreadBoard — WorkThread 的可选平行执行看板（看板层）
 *
 * 移植自 Claw `server/thread-control/thread-controller.js` 的执行调度部分，按
 * ADR-0002/Q4=C 拆分为独立平行模块，经 workThreadId 与锚点层关联，宿主选用。
 *
 * 承载：
 *   - executionEvents 持久化（codex `turn.*` / `item.*` 事件审计）
 *   - `recordRuntimeEvent`（codex turn 事件流 → 看板状态翻译）
 *   - resume、mode
 *   - idle / running / waiting_input / failed 执行状态机
 *
 * 纪律（写死在本模块头注释）：**看板永不反写锚点状态。** 本模块只读锚点记录的
 * 定位信息（经 core.findThreadByHeadSession 取 workThreadId 与 closed 判定），
 * 只写自己独立的看板持久化域，绝不调用 core 的 advanceHead / beginSessionHandoff /
 * setHold / closeThread 等锚点写路径。
 *
 * closed 两处语义（核心 terminal 判定 + 看板终态）：看板对 closed 线程拒绝
 * runtime 事件（thread_closed）；宿主在锚点关闭时经 closeBoard 将看板置为终态。
 */

import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import type { WorkThread } from './core.js';
import { sanitizeWorkThreadFragment } from './store.js';

export type WorkThreadBoardStatus =
  | 'idle'
  | 'running'
  | 'waiting_input'
  | 'failed'
  | 'closed';

export type WorkThreadBoardMode = 'interactive' | 'autonomous';

export interface WorkThreadBoardExecutionEvent {
  eventId: string;
  receivedAt: number;
  sessionId: string;
  runtimeInstanceId: string | null;
  event: Record<string, unknown>;
}

export interface WorkThreadBoardLifecycleEvent {
  type: string;
  status: string;
  at: number;
  [key: string]: unknown;
}

export interface WorkThreadBoardState {
  workThreadId: string;
  mode: WorkThreadBoardMode;
  status: WorkThreadBoardStatus;
  executionEvents: WorkThreadBoardExecutionEvent[];
  /**
   * 已从 executionEvents 窗口裁掉的事件总数（ticket 017）。
   * 绝对游标 = executionEventBaseOffset + executionEvents.length，随状态落盘，
   * 保证进程重启后 cursor 不回退。旧状态文件缺省时按 0 读取。
   */
  executionEventBaseOffset: number;
  lifecycleEvents: WorkThreadBoardLifecycleEvent[];
  lastLifecycleEvent: WorkThreadBoardLifecycleEvent | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export const WORKTHREAD_BOARD_STATUSES: ReadonlySet<WorkThreadBoardStatus> = new Set([
  'idle',
  'running',
  'waiting_input',
  'failed',
  'closed',
]);

export const WORKTHREAD_BOARD_OPEN_STATUSES: ReadonlySet<WorkThreadBoardStatus> = new Set([
  'idle',
  'running',
  'waiting_input',
  'failed',
]);

// 执行状态机转换矩阵（看板层契约）。closed 为终态。
const BOARD_TRANSITIONS: Record<WorkThreadBoardStatus, ReadonlySet<WorkThreadBoardStatus>> = {
  idle: new Set(['running', 'waiting_input', 'failed', 'closed']),
  running: new Set(['idle', 'waiting_input', 'failed', 'closed']),
  waiting_input: new Set(['running', 'idle', 'closed']),
  failed: new Set(['running', 'idle', 'closed']),
  closed: new Set(),
};

const BOARD_STATUSES = new Set<string>([
  'idle',
  'running',
  'waiting_input',
  'failed',
  'closed',
]);
const BOARD_MODES = new Set<string>(['interactive', 'autonomous']);

const MAX_EXECUTION_EVENTS = 500;
const MAX_LIFECYCLE_EVENTS = 200;

export interface WorkThreadBoardOptions {
  core: WorkThread;
  rootDir: string;
}

export class WorkThreadBoard {
  readonly core: WorkThread;
  readonly boardsDir: string;
  private _locks = new Map<string, Promise<void>>();

  constructor({ core, rootDir }: WorkThreadBoardOptions) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new Error('WorkThreadBoard requires a rootDir');
    }
    this.core = core;
    this.boardsDir = join(rootDir, 'boards');
  }

  // ── 内部持久化（独立看板域，与锚点 store 分离）──────────────

  private boardFilePath(workThreadId: string): string {
    return join(this.boardsDir, `${sanitizeWorkThreadFragment(workThreadId)}.board.json`);
  }

  async getBoardId(workThreadId: string): Promise<string> {
    return workThreadId;
  }

  async getState(workThreadId: string): Promise<WorkThreadBoardState | null> {
    try {
      return JSON.parse(
        await readFile(this.boardFilePath(workThreadId), 'utf8'),
      ) as WorkThreadBoardState;
    } catch {
      return null;
    }
  }

  private async atomicWriteJson(filePath: string, data: unknown): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    try {
      await rename(tmpPath, filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        await unlink(filePath).catch(() => {});
        await rename(tmpPath, filePath);
      } else if (code === 'EXDEV') {
        await copyFile(tmpPath, filePath);
        await unlink(tmpPath).catch(() => {});
      } else {
        throw err;
      }
    }
  }

  private async ensureInit(workThreadId: string, mode: WorkThreadBoardMode): Promise<WorkThreadBoardState> {
    const existing = await this.getState(workThreadId);
    if (existing) return existing;
    await mkdir(this.boardsDir, { recursive: true });
    const now = Date.now();
    const initial: WorkThreadBoardState = {
      workThreadId,
      mode,
      status: 'idle',
      executionEvents: [],
      executionEventBaseOffset: 0,
      lifecycleEvents: [],
      lastLifecycleEvent: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.atomicWriteJson(this.boardFilePath(workThreadId), initial);
    return initial;
  }

  private async mutate(
    workThreadId: string,
    mutFn: (state: WorkThreadBoardState) => WorkThreadBoardState,
    mode: WorkThreadBoardMode = 'interactive',
  ): Promise<{ state: WorkThreadBoardState; changed: boolean }> {
    const prev = this._locks.get(workThreadId) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this._locks.set(workThreadId, next);
    await prev.catch(() => {});
    try {
      const state = (await this.getState(workThreadId)) || (await this.ensureInit(workThreadId, mode));
      const before = JSON.stringify(state);
      const proposed = mutFn(state);
      if (!proposed) return { state, changed: false };
      const after = JSON.stringify(proposed);
      if (after === before) {
        return { state, changed: false };
      }
      const nextState: WorkThreadBoardState = {
        ...proposed,
        revision: (Number(state.revision) || 0) + 1,
        updatedAt: Date.now(),
      };
      await this.atomicWriteJson(this.boardFilePath(workThreadId), nextState);
      return { state: nextState, changed: true };
    } finally {
      release();
      if (this._locks.get(workThreadId) === next) this._locks.delete(workThreadId);
    }
  }

  private pushLifecycle(state: WorkThreadBoardState, event: WorkThreadBoardLifecycleEvent): void {
    state.lifecycleEvents = Array.isArray(state.lifecycleEvents) ? state.lifecycleEvents : [];
    state.lifecycleEvents.push(event);
    if (state.lifecycleEvents.length > MAX_LIFECYCLE_EVENTS) {
      state.lifecycleEvents.splice(0, state.lifecycleEvents.length - MAX_LIFECYCLE_EVENTS);
    }
    state.lastLifecycleEvent = event;
  }

  private canTransition(from: WorkThreadBoardStatus, to: WorkThreadBoardStatus): boolean {
    return from === to || BOARD_TRANSITIONS[from]?.has(to) === true;
  }

  // ── 查询 ─────────────────────────────────────────────────────────

  /**
   * 读取看板 executionEvents，支持 cursor 切片。
   *
   * cursor 是绝对游标（baseOffset + 窗口长度，ticket 017）：跨裁剪点单调递增，
   * 长期增量消费者（轮询 after=cursor）不丢事件。`after` 落后于窗口起点时
   * clamp 到窗口起点从头返回当前可用窗口——旧数据已裁掉不可恢复，但绝不以
   * 空数组静默丢读；消费者可用 eventId 去重。
   * @returns {{events, cursor}}
   */
  async getExecutionEvents(
    workThreadId: string,
    opts: { after?: number } = {},
  ): Promise<{ events: Record<string, unknown>[]; cursor: number }> {
    const state = await this.getState(workThreadId);
    if (!state) return { events: [], cursor: 0 };
    const events = Array.isArray(state.executionEvents) ? state.executionEvents : [];
    const baseOffset = Math.max(0, Number(state.executionEventBaseOffset) || 0);
    const after = Math.max(0, Number(opts.after) || 0);
    const from = after < baseOffset ? 0 : after - baseOffset;
    return {
      events: events.slice(from).map((entry) => entry.event),
      cursor: baseOffset + events.length,
    };
  }

  // ── 事件翻译（执行调度状态机）─────────────────────────────────

  /**
   * 把一个 codex (`turn.*` / `item.*`) 运行时事件应用到看板层。
   *
   * 通过 core.findThreadByHeadSession 定位 workThreadId（只读锚点定位），
   * 只在看板域写状态与 executionEvents；closed 线程拒绝迟到观测事件。
   *
   * @returns {{applied: boolean, reason?: string, thread?: WorkThreadBoardState}}
   */
  async recordRuntimeEvent(opts: {
    agentId: string;
    sessionId: string;
    runtimeInstanceId?: string | null;
    event: Record<string, unknown>;
  }): Promise<{ applied: boolean; reason?: string; state?: WorkThreadBoardState }> {
    const { agentId, sessionId, runtimeInstanceId = null, event } = opts;

    const anchor = await this.core.findThreadByHeadSession(agentId, sessionId);
    if (!anchor) return { applied: false, reason: 'no_thread_for_session' };
    // closed 线程不再接受任何 runtime 事件（含 item.*），迟到的观测事件显式忽略。
    if (this.core.isTerminal(anchor)) return { applied: false, reason: 'thread_closed' };

    const type = typeof event?.type === 'string' ? event.type.trim() : '';
    if (!type) return { applied: false, reason: 'invalid_event' };

    const workThreadId = anchor.threadId;
    const details = {
      sessionId: typeof sessionId === 'string' ? sessionId.trim() : '',
      runtimeInstanceId:
        typeof runtimeInstanceId === 'string' && runtimeInstanceId.trim()
          ? runtimeInstanceId.trim()
          : null,
      turn: Number.isInteger(event?.turn) ? event.turn : null,
    };

    const eventId =
      (typeof event?.eventId === 'string' && event.eventId.trim()) ||
      `${details.runtimeInstanceId || 'runtime'}:${type}:${details.turn ?? 'none'}:${
        (event?.item as { id?: unknown })?.id || Date.now()
      }`;

    const appendExecutionEvent = async (threadId: string): Promise<WorkThreadBoardState> => {
      const { state } = await this.mutate(threadId, (draft) => {
        draft.executionEvents = Array.isArray(draft.executionEvents) ? draft.executionEvents : [];
        if (draft.executionEvents.some((entry) => entry.eventId === eventId)) return draft;
        draft.executionEvents.push({
          eventId,
          receivedAt: Date.now(),
          sessionId: details.sessionId,
          runtimeInstanceId: details.runtimeInstanceId,
          event: { ...event },
        });
        if (draft.executionEvents.length > MAX_EXECUTION_EVENTS) {
          const removed = draft.executionEvents.length - MAX_EXECUTION_EVENTS;
          draft.executionEvents.splice(0, removed);
          draft.executionEventBaseOffset = Math.max(0, Number(draft.executionEventBaseOffset) || 0) + removed;
        }
        return draft;
      });
      return state;
    };

    const transition = async (
      threadId: string,
      status: WorkThreadBoardStatus,
      eventType: string,
      extra: Record<string, unknown> = {},
    ): Promise<WorkThreadBoardState> => {
      const { state } = await this.mutate(threadId, (draft) => {
        if (draft.status === 'closed') return draft;
        if (!this.canTransition(draft.status, status)) {
          throw Object.assign(
            new Error(`Invalid board transition: ${draft.status} -> ${status}`),
            { code: 'invalid_board_transition', status: 409 },
          );
        }
        draft.status = status;
        this.pushLifecycle(draft, { type: eventType, status, at: Date.now(), ...details, ...extra });
        return draft;
      });
      return state;
    };

    if (type === 'item.started' || type === 'item.completed') {
      return { applied: true, state: await appendExecutionEvent(workThreadId) };
    }
    if (type === 'turn.started') {
      await transition(workThreadId, 'running', type);
      return { applied: true, state: await appendExecutionEvent(workThreadId) };
    }
    if (type === 'turn.completed') {
      await transition(workThreadId, 'idle', type, { usage: event.usage || null });
      return { applied: true, state: await appendExecutionEvent(workThreadId) };
    }
    if (type === 'turn.cancelled') {
      // 生命周期信号（guard 轮换 / 宿主中断）：只记录，不做状态转换。
      return { applied: true, state: await appendExecutionEvent(workThreadId) };
    }
    if (type === 'turn.failed') {
      await transition(workThreadId, 'failed', type, { error: event.error || null });
      return { applied: true, state: await appendExecutionEvent(workThreadId) };
    }
    return { applied: false, reason: 'unsupported_event' };
  }

  // ── resume / mode ──────────────────────────────────────────────

  /**
   * 从 failed / waiting_input 恢复执行（看板状态 running）。
   * 看板永不反写锚点状态——恢复只改看板状态，锚点交接意图由宿主另行收拾。
   */
  async resume(workThreadId: string, opts: { source?: string } = {}): Promise<WorkThreadBoardState> {
    const state = (await this.getState(workThreadId)) || (await this.ensureInit(workThreadId, 'interactive'));
    if (state.status === 'closed') {
      throw Object.assign(new Error(`WorkThreadBoard "${workThreadId}" is closed`), {
        code: 'thread_closed',
        status: 409,
      });
    }
    if (state.status !== 'failed' && state.status !== 'waiting_input') {
      throw Object.assign(new Error(`WorkThreadBoard "${workThreadId}" cannot be resumed from ${state.status}`), {
        code: 'board_not_resumable',
        status: 409,
      });
    }
    const { state: next } = await this.mutate(workThreadId, (draft) => {
      draft.status = 'running';
      this.pushLifecycle(draft, {
        type: 'resumed',
        status: 'running',
        at: Date.now(),
        source: typeof opts.source === 'string' ? opts.source.trim() : 'api',
      });
      return draft;
    });
    return next;
  }

  async setMode(workThreadId: string, mode: WorkThreadBoardMode): Promise<WorkThreadBoardState> {
    if (!BOARD_MODES.has(mode)) {
      throw Object.assign(new Error(`Invalid board mode: ${mode}`), {
        code: 'invalid_board_mode',
        status: 400,
      });
    }
    const { state } = await this.mutate(workThreadId, (draft) => {
      if (draft.mode === mode) return draft;
      draft.mode = mode;
      return draft;
    });
    return state;
  }

  /**
   * 手动播种看板状态（宿主用于 `waiting_input` 等无事件源的场景——例如前端在
   * 等待人工输入时显式置位）。仅改看板域，不反写锚点状态。
   */
  async setStatus(workThreadId: string, status: WorkThreadBoardStatus): Promise<WorkThreadBoardState> {
    if (!BOARD_STATUSES.has(status)) {
      throw Object.assign(new Error(`Invalid board status: ${status}`), {
        code: 'invalid_board_status',
        status: 400,
      });
    }
    const { state } = await this.mutate(workThreadId, (draft) => {
      if (draft.status === status) return draft;
      draft.status = status;
      this.pushLifecycle(draft, { type: 'status_seeded', status, at: Date.now() });
      return draft;
    });
    return state;
  }

  /**
   * 把看板置为终态（锚点已关闭）。与核心 terminal 判定对应的看板终态。
   */
  async closeBoard(workThreadId: string, opts: { reason?: string } = {}): Promise<WorkThreadBoardState> {
    const { state } = await this.mutate(workThreadId, (draft) => {
      if (draft.status === 'closed') return draft;
      draft.status = 'closed';
      this.pushLifecycle(draft, {
        type: 'board_closed',
        status: 'closed',
        at: Date.now(),
        reason: typeof opts.reason === 'string' ? opts.reason.trim() : 'closed',
      });
      return draft;
    });
    return state;
  }

  /** 状态机转换矩阵（公开，供测试与宿主校验）。 */
  getTransitionMatrix(): Record<WorkThreadBoardStatus, WorkThreadBoardStatus[]> {
    const out = {} as Record<WorkThreadBoardStatus, WorkThreadBoardStatus[]>;
    for (const s of Object.keys(BOARD_STATUSES) as WorkThreadBoardStatus[]) {
      out[s] = [...BOARD_TRANSITIONS[s]];
    }
    return out;
  }
}
