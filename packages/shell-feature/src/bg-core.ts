/**
 * 后台 Bash 核心 — 任务登记表 + 双节奏汇报引擎 + 通知投递管线
 *
 * 设计契约（bg 心智模型，与 tool-bash-bg.md 保持一致）：
 * - 前台/后台是模型的预期表达，误判由 harness 兜底：
 *   前台超预算 → 不打断进程，转后台（继承前台预算作为初始紧凑节奏）；
 *   后台 2s 内退出 → 结果直接带回（等价前台体验）。
 * - 双节奏（interval=活跃节奏，纯墙钟；quietAfter=静默节奏，输出重置计时）：
 *   任一触发即汇报并互重置计时；exit 为最高优先级事件，与 pending 定时器
 *   同时到达时 exit 赢（丢弃节拍汇报，不发鬼魂消息）。
 * - readyPattern：输出首次匹配即发一次性"已就绪"，此后任务按节奏继续汇报。
 * - 通知经 ViewerWorker user-turn 邮箱投递（与 react-loop 相同的端口约定，
 *   框架内已先例使用内置 fetch）；投递失败保留在任务上，bg_status 补发。
 * - 任务生命周期 = 宿主进程生命周期（process exit 时尽力终止全部任务）。
 *
 * 本模块不设内部 sleep/轮询：所有定时器均 setTimeout 链 + unref。
 */

import { spawn, type ChildProcess } from 'child_process';
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
} from './shellQuoting.js';
import {
  drainToEof,
  makeKillChild,
  processOutputWithPersistence,
} from './shell-core.js';

// ---------------------------------------------------------------------------
// 契约常量
// ---------------------------------------------------------------------------

/** 模型可声明节奏的下限（转后台继承的初始节奏不受此限，见 BgTaskPace 注释）。 */
export const BG_MIN_INTERVAL_MS = 60_000;
export const BG_MIN_QUIET_MS = 30_000;
/** bash_bg 启动后的快速捕获窗：窗口内退出直接带回结果。 */
export const BG_CAPTURE_WINDOW_MS = 2_000;
/** 每任务输出环形缓冲上限（字节，保留尾部）。 */
export const BG_RING_BUFFER_MAX_BYTES = 256 * 1024;
export const BG_MAX_RUNNING = 8;
export const BG_KEEP_DONE = 5;
/** 多任务通知聚合窗口：窗口内的通知合并为一条 user-turn。 */
export const BG_AGGREGATION_WINDOW_MS = 250;
/** 通知文本中携带的尾部输出长度（字符）。 */
export const BG_NOTIFY_TAIL_CHARS = 2_000;
/** bg_wait 单次等待上限。 */
export const BG_WAIT_MAX_MS = 30_000;
/** 前台命令固定预算（毫秒）；宿主可经 manifest 配置覆盖。 */
export const FOREGROUND_BUDGET_DEFAULT_MS = 20_000;
/** 投递 HTTP 超时。 */
const DELIVER_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type BgTaskStatus = 'running' | 'done' | 'killed';

export interface BgTaskPace {
  /** 活跃节奏（毫秒）：正常运行时最坏每隔此值汇报一次（纯墙钟，不被输出重置）。 */
  intervalMs: number;
  /** 静默节奏（毫秒）：进程无输出持续此值后按此节奏汇报"无动静"。 */
  quietAfterMs: number;
}

export interface BgSpawnOptions {
  workdir: string;
  bashPath: string;
  resourceRoot: string;
}

export interface BgTaskSnapshot {
  id: string;
  command: string;
  status: BgTaskStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  quietMs: number;
  pace: BgTaskPace;
  readyPattern: string | null;
  readyFired: boolean;
  nextReportInMs: number | null;
  inheritedPace: boolean;
  outputTailChars: number;
  droppedOutputBytes: number;
}

interface BgTask {
  id: string;
  command: string;
  workdir: string;
  child: ChildProcess | null;
  startedAt: number;
  status: BgTaskStatus;
  exitCode: number | null;
  endedAt: number | null;
  /** 环形缓冲：尾部 chunks + 绝对字节游标（droppedBytes 起有效）。 */
  chunks: string[];
  totalBytes: number;
  droppedBytes: number;
  lastOutputAt: number;
  /**
   * 最近一次汇报（节拍/静默/就绪）时刻。静默计时的锚点是
   * max(lastOutputAt, lastReportAt)：节拍触发后静默窗口从汇报时刻重新起算，
   * 否则"已静默超 quietAfter 时节拍触发"会让 quiet timer 剩余量为 0，
   * 形成零延迟触发风暴（互重置语义的一半）。
   */
  lastReportAt: number;
  /** bg_status 增量读取游标（绝对字节）。 */
  readOffset: number;
  /**
   * 通知增量游标（绝对字节）：节拍/静默/就绪注入自上次通知以来的新输出。
   * 与 readOffset 独立——通知推进自己的游标，不碰 bg_status 的读取语义；
   * 反之 bg_status 的主动查看也不影响后续通知的增量起算。
   */
  notifyOffset: number;
  pace: BgTaskPace;
  inheritedPace: boolean;
  readyPattern: string | null;
  readyFired: boolean;
  intervalTimer: ReturnType<typeof setTimeout> | null;
  quietTimer: ReturnType<typeof setTimeout> | null;
  /** 投递失败滞留的通知文本（bg_status 时补发）。 */
  unsent: string[];
  finalizeWaiters: Array<() => void>;
  pendingOutput: string;
}

export interface BgRegisterOptions extends BgTaskPace {
  command: string;
  workdir: string;
  readyPattern?: string | null;
  /** 前台转后台：转后台前已积累的输出（进 ring buffer，静默计时起点相应后移）。 */
  preOutput?: string;
  /** 前台转后台继承：允许低于 BG_MIN_*（模型无法经此路径自定节奏）。 */
  inherited?: boolean;
}

export type ForegroundOutcome =
  | { kind: 'completed'; code: number; stdout: string; stderr: string }
  | { kind: 'aborted'; stdout: string; stderr: string }
  /** 用户主动打断：kill + drain 后的部分输出（ADR-0005 终止收集，语义不变）。 */
  | { kind: 'terminated'; stdout: string; stderr: string; reason: string; durationMs: number };

// ---------------------------------------------------------------------------
// 命令构造（与 runShellCommand 等价：quoting / bashrc / stdin redirect）
// ---------------------------------------------------------------------------

export function buildBashInvocation(
  command: string,
  opts: BgSpawnOptions,
): { execPath: string; args: string[]; env: NodeJS.ProcessEnv } {
  const resourceRoot = opts.resourceRoot.replace(/\\/g, '/');
  const bashrcPath = resourceRoot + '/.agentdev/bashrc';
  const normalizedCommand = rewriteWindowsNullRedirect(command);
  // 后台永不加 `< /dev/null` 防挂起重定向：stdin 留 pipe 供 bg_control 写入，
  // 等待输入的命令挂起是产品语义（防挂起是前台概念，那里没有写入口）。
  const quotedCommand = quoteShellCommand(normalizedCommand, false);
  const quotedBashrc = `'${bashrcPath.replace(/'/g, `'\\''`)}'`;
  const commandString = `source ${quotedBashrc} 2>/dev/null || true; eval ${quotedCommand}`;
  const isWin = process.platform === 'win32';
  return {
    execPath: opts.bashPath,
    args: ['-c', commandString],
    env: {
      ...process.env,
      ...(isWin ? { MSYSTEM: process.env.MSYSTEM || 'MINGW64' } : {}),
    },
  };
}

/** 后台 spawn：stdin 留 pipe（bg_control 可写），`< /dev/null` 重定向防挂起语义不变。 */
export function spawnBackgroundProcess(
  command: string,
  opts: BgSpawnOptions,
): ChildProcess {
  const inv = buildBashInvocation(command, opts);
  const child = spawn(inv.execPath, inv.args, {
    cwd: opts.workdir,
    env: inv.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX 后台任务脱离控制组但不脱离会话：kill 仍可用进程组（detached 同
    // runCollectedProcess 语义）；Windows 经 taskkill /T 树杀。
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });
  return child;
}

// ---------------------------------------------------------------------------
// 登记表
// ---------------------------------------------------------------------------

export interface BgRegistryOptions {
  agentId: string;
  /** 投递目标 ViewerWorker 基址（缺省 127.0.0.1:AGENTDEV_VIEWER_PORT||2026）。 */
  viewerUrl?: string;
  /** 测试禁用 process exit 兜底。 */
  enableExitGuard?: boolean;
  /** 测试注入投递函数。 */
  deliverImpl?: (text: string, sourceRef: string) => Promise<void>;
  /** 测试注入时钟。 */
  now?: () => number;
}

export class BgRegistry {
  private readonly _tasks = new Map<string, BgTask>();
  private _nextId = 1;
  private readonly _agentId: string;
  private readonly _viewerUrl: string;
  private readonly _deliverImpl: (text: string, sourceRef: string) => Promise<void>;
  private readonly _now: () => number;
  private readonly _exitGuard: (() => void) | null;
  private _pendingNotify: Array<{ taskId: string; text: string }> = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BgRegistryOptions) {
    this._agentId = opts.agentId;
    const port = process.env.AGENTDEV_VIEWER_PORT || '2026';
    this._viewerUrl = opts.viewerUrl ?? `http://127.0.0.1:${port}`;
    this._deliverImpl = opts.deliverImpl ?? ((text, sourceRef) => this._httpDeliver(text, sourceRef));
    this._now = opts.now ?? Date.now;
    this._exitGuard = opts.enableExitGuard === false
      ? null
      : () => this.killAll();
    if (this._exitGuard) {
      process.on('exit', this._exitGuard);
    }
  }

  // -- 查询 ---------------------------------------------------------------

  get(taskId: string): BgTask | undefined {
    return this._tasks.get(taskId);
  }

  list(): BgTaskSnapshot[] {
    return [...this._tasks.values()].map((t) => this.snapshot(t));
  }

  snapshot(task: BgTask): BgTaskSnapshot {
    const now = this._now();
    // 下次汇报剩余 = min(interval 剩余, quiet 剩余)，锚点与引擎一致。
    const nextIn = task.status === 'running'
      ? Math.max(
          0,
          Math.min(
            task.pace.intervalMs - (now - task.lastReportAt),
            task.pace.quietAfterMs - (now - Math.max(task.lastOutputAt, task.lastReportAt)),
          ),
        )
      : null;
    return {
      id: task.id,
      command: task.command,
      status: task.status,
      exitCode: task.exitCode,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      durationMs: (task.endedAt ?? now) - task.startedAt,
      quietMs: now - task.lastOutputAt,
      pace: { ...task.pace },
      readyPattern: task.readyPattern,
      readyFired: task.readyFired,
      nextReportInMs: nextIn,
      inheritedPace: task.inheritedPace,
      outputTailChars: this.tail(task, 1_000).length,
      droppedOutputBytes: task.droppedBytes,
    };
  }

  /** 自 readOffset 起的增量输出；游标被环形丢弃越过时前移并标注。 */
  readSince(task: BgTask, offset: number): { text: string; nextOffset: number; clamped: boolean } {
    let start = Math.max(offset, task.droppedBytes);
    const clamped = start > offset;
    const idx = this._offsetToIndex(task, start);
    const text = task.chunks.slice(idx).join('');
    return { text, nextOffset: task.totalBytes, clamped };
  }

  /** 尾部输出（字符）。 */
  tail(task: BgTask, maxChars: number): string {
    const text = task.chunks.join('');
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  /** bg_status 视角的完整读取：状态 + 增量 + 滞留通知补发。 */
  statusView(task: BgTask): {
    snapshot: BgTaskSnapshot;
    newOutput: string;
    clamped: boolean;
    unsentCatchUp: string[];
  } {
    const read = this.readSince(task, task.readOffset);
    task.readOffset = read.nextOffset;
    const unsentCatchUp = task.unsent;
    task.unsent = [];
    return {
      snapshot: this.snapshot(task),
      newOutput: read.text,
      clamped: read.clamped,
      unsentCatchUp,
    };
  }

  // -- 注册 / 收养 ----------------------------------------------------------

  /** running 配额检查（转后台收养共享同一配额）。 */
  runningCount(): number {
    let n = 0;
    for (const t of this._tasks.values()) if (t.status === 'running') n++;
    return n;
  }

  register(child: ChildProcess, opts: BgRegisterOptions): BgTask {
    if (this.runningCount() >= BG_MAX_RUNNING) {
      throw new Error(
        `后台任务已达上限（${BG_MAX_RUNNING}）。请用 bg_list 查看，kill 不再需要的任务后再启动。`,
      );
    }
    // inherited 值来自内部（前台预算）；模型声明值必须有限（NaN 会让 setTimeout
    // 按 0 延迟处理，形成汇报风暴）。
    const intervalMs = opts.inherited === true ? opts.intervalMs : mustFinite(opts.intervalMs, 'intervalMs');
    const quietAfterMs = opts.inherited === true ? opts.quietAfterMs : mustFinite(opts.quietAfterMs, 'quietAfterMs');
    const id = `bg-${this._nextId++}`;
    const now = this._now();
    const task: BgTask = {
      id,
      command: opts.command,
      workdir: opts.workdir,
      child,
      startedAt: now,
      status: 'running',
      exitCode: null,
      endedAt: null,
      chunks: [],
      totalBytes: 0,
      droppedBytes: 0,
      lastOutputAt: now,
      lastReportAt: now,
      readOffset: 0,
      notifyOffset: 0,
      pace: {
        // inherited（前台转后台）允许低于下限：20s 紧凑节奏是转后台时刻的
        // 真实紧迫度，且模型无法经此路径自定节奏（前台已无 timeout 字段）。
        intervalMs: opts.inherited === true ? intervalMs : Math.max(intervalMs, BG_MIN_INTERVAL_MS),
        quietAfterMs: opts.inherited === true ? quietAfterMs : Math.max(quietAfterMs, BG_MIN_QUIET_MS),
      },
      inheritedPace: opts.inherited === true,
      readyPattern: opts.readyPattern ?? null,
      readyFired: false,
      intervalTimer: null,
      quietTimer: null,
      unsent: [],
      finalizeWaiters: [],
      pendingOutput: '',
    };
    this._tasks.set(id, task);
    if (opts.preOutput) {
      this._appendOutput(task, opts.preOutput);
      task.lastOutputAt = this._now();
    }
    this._attachCollectors(child, task);
    this._armTimers(task);
    return task;
  }

  private _attachCollectors(child: ChildProcess, task: BgTask): void {
    // stdin 写入目标消失时的 EPIPE/destroyed 异步 error 无人接会崩掉 agent 宿主
    // 进程（模型对刚结束的任务回写确认是现实序列）——挂 no-op 监听兜底。
    child.stdin?.on?.('error', () => { /* 写入目标已消失，忽略 */ });
    const onChunk = (data: Buffer | string) => {
      if (task.status !== 'running') return; // exit 赢：close 后残余数据丢弃
      const text = data.toString();
      this._appendOutput(task, text);
      task.lastOutputAt = this._now();
      this._resetQuietTimer(task);
      this._checkReady(task);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      if (task.status !== 'running') return;
      this._appendOutput(task, `[进程错误] ${String(err)}\n`);
      this._finalize(task, 'done', null);
    });
    child.on('close', (code) => {
      this._finalize(task, 'done', code);
    });
  }

  private _appendOutput(task: BgTask, text: string): void {
    const bytes = Buffer.byteLength(text, 'utf-8');
    task.chunks.push(text);
    task.totalBytes += bytes;
    // 环形丢弃：超出上限时丢头部 chunk（保留尾部）。
    while (task.totalBytes - task.droppedBytes - Buffer.byteLength(task.chunks[0] ?? '', 'utf-8') >= BG_RING_BUFFER_MAX_BYTES && task.chunks.length > 1) {
      task.droppedBytes += Buffer.byteLength(task.chunks[0], 'utf-8');
      task.chunks.shift();
    }
  }

  private _offsetToIndex(task: BgTask, absOffset: number): number {
    let cursor = task.droppedBytes;
    for (let i = 0; i < task.chunks.length; i++) {
      const size = Buffer.byteLength(task.chunks[i], 'utf-8');
      if (cursor + size > absOffset) return i;
      cursor += size;
    }
    return task.chunks.length;
  }

  // -- 双节奏引擎 -----------------------------------------------------------

  private _armTimers(task: BgTask): void {
    this._clearTimers(task);
    if (task.status !== 'running') return;
    task.intervalTimer = setTimeout(() => this._firePace(task, 'interval'), task.pace.intervalMs);
    task.intervalTimer.unref?.();
    this._resetQuietTimer(task);
  }

  /** 节拍/静默汇报共用出口：exit 赢检查 + 互重置。 */
  private _firePace(task: BgTask, reason: 'interval' | 'quiet'): void {
    if (task.status !== 'running') return; // exit 赢
    task.lastReportAt = this._now();
    const quietSec = Math.round((this._now() - task.lastOutputAt) / 1000);
    // 通知增量 = 自上次通知以来的新输出（notifyOffset 独立游标，构造即推进——
    // 投递失败进 unsent 由 bg_status 补发，不因补发丢量或重复）。不推 readOffset：
    // bg_status 的主动查看语义不受通知影响。
    const read = this.readSince(task, task.notifyOffset);
    task.notifyOffset = read.nextOffset;
    const delta = read.text;
    const tail = delta.length > BG_NOTIFY_TAIL_CHARS ? `…${delta.slice(-BG_NOTIFY_TAIL_CHARS)}` : delta;
    this._notify(task, [
      `[后台任务 ${task.id} 运行中] ${reason === 'quiet' ? `已 ${quietSec} 秒无新输出` : '周期汇报'} · 已运行 ${fmtDur(this._now() - task.startedAt)}`,
      tail ? `新增输出:\n${tail}` : '（无新增输出）',
      '无需操作；需要干预时用 bg_status / bg_control。',
    ].join('\n'));
    this._armTimers(task); // 任一触发即互重置
  }

  /** 输出到达只重置静默计时（活跃节奏是纯墙钟）。锚点取 max(输出, 上次汇报)。 */
  private _resetQuietTimer(task: BgTask): void {
    if (task.status !== 'running') return;
    if (task.quietTimer) clearTimeout(task.quietTimer);
    const anchor = Math.max(task.lastOutputAt, task.lastReportAt);
    const remain = Math.max(0, task.pace.quietAfterMs - (this._now() - anchor));
    task.quietTimer = setTimeout(() => {
      task.quietTimer = null;
      this._firePace(task, 'quiet');
    }, remain);
    task.quietTimer.unref?.();
  }

  private _checkReady(task: BgTask): void {
    if (!task.readyPattern || task.readyFired || task.status !== 'running') return;
    if (this.tail(task, 10_000).includes(task.readyPattern)) {
      task.readyFired = true;
      task.lastReportAt = this._now();
      // 就绪事件消耗掉此前的输出增量：下条节拍只报就绪之后的新输出。
      task.notifyOffset = task.totalBytes;
      this._notify(task, [
        `[后台任务 ${task.id} 已就绪] 输出匹配就绪标志，任务继续在后台运行。`,
        `命令: ${task.command}`,
      ].join('\n'));
      this._armTimers(task); // 就绪事件重置双节奏
    }
  }

  private _clearTimers(task: BgTask): void {
    if (task.intervalTimer) { clearTimeout(task.intervalTimer); task.intervalTimer = null; }
    if (task.quietTimer) { clearTimeout(task.quietTimer); task.quietTimer = null; }
  }

  // -- 终态 -----------------------------------------------------------------

  private _finalize(task: BgTask, status: BgTaskStatus, exitCode: number | null): void {
    if (task.status !== 'running') return; // 幂等 + exit 赢（kill 预置 killed）
    task.status = status;
    task.exitCode = exitCode;
    task.endedAt = this._now();
    task.child = null;
    this._clearTimers(task);
    const tail = this.tail(task, BG_NOTIFY_TAIL_CHARS);
    const label = status === 'killed' ? '已终止' : exitCode === 0 ? '已完成' : '已失败';
    this._notify(task, [
      `[后台任务 ${task.id} ${label}]`,
      `命令: ${task.command}`,
      `退出码: ${exitCode === null ? 'null' : exitCode} · 运行时长 ${fmtDur(task.endedAt - task.startedAt)}`,
      ...(tail ? [`尾部输出:\n${tail}`] : []),
    ].join('\n'));
    this._trimDone();
    for (const wake of task.finalizeWaiters.splice(0)) wake();
  }

  private _trimDone(): void {
    const done = [...this._tasks.values()].filter((t) => t.status !== 'running');
    while (done.length > BG_KEEP_DONE) {
      const oldest = done.shift();
      if (oldest) this._tasks.delete(oldest.id);
    }
  }

  // -- 控制 -----------------------------------------------------------------

  /**
   * 终止任务。graceful（工具面）：POSIX 先 SIGTERM 进程组，2s 未退出再 SIGKILL
   * ——dev server 等长任务能优雅退出；Windows taskkill 无 TERM 等价物，保持 /F。
   * 内部清理路径（killAll / dispose / exit guard）不 graceful：进程即将同步退出，
   * 没有机会补刀。
   */
  kill(taskId: string, opts: { graceful?: boolean } = {}): boolean {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    const child = task.child;
    this._finalize(task, 'killed', null); // 先置终态：close 事件不再重复 finalize
    if (child) {
      try {
        if (opts.graceful && process.platform !== 'win32' && typeof child.pid === 'number') {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { return true; /* 已退出 */ }
          const escalation = setTimeout(() => {
            try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退出 */ }
          }, 2_000);
          escalation.unref?.();
        } else {
          makeKillChild(child)();
        }
      } catch { /* 已退出 */ }
    }
    return true;
  }

  writeStdin(taskId: string, data: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== 'running' || !task.child?.stdin) return false;
    try {
      task.child.stdin.write(data);
    } catch {
      return false; // 流已销毁（进程刚好退出）：不是崩溃，报告写入失败即可
    }
    return true;
  }

  /**
   * 调整节奏：立即生效并重置计时起点。统一 clamp 到 BG_MIN_*（转后台任务的
   * 20s 继承节奏低于下限，因此 tune 只能调宽——防止模型借 tune 恢复紧凑节奏）。
   */
  tune(taskId: string, pace: Partial<BgTaskPace>): BgTaskPace | null {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== 'running') return null;
    task.pace = {
      intervalMs: Math.max(BG_MIN_INTERVAL_MS, mustFinite(pace.intervalMs ?? task.pace.intervalMs, 'intervalMs')),
      quietAfterMs: Math.max(BG_MIN_QUIET_MS, mustFinite(pace.quietAfterMs ?? task.pace.quietAfterMs, 'quietAfterMs')),
    };
    this._armTimers(task);
    return { ...task.pace };
  }

  killAll(): void {
    for (const task of this._tasks.values()) {
      if (task.status === 'running') this.kill(task.id);
    }
  }

  dispose(): void {
    this.killAll();
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    // 聚合窗口内未投递的通知摊还给各任务（unsent）：bg_status 仍可补发，
    // 不随 dispose 静默消失。
    for (const n of this._pendingNotify) {
      this._tasks.get(n.taskId)?.unsent.push(n.text);
    }
    this._pendingNotify = [];
    if (this._exitGuard) process.removeListener('exit', this._exitGuard);
  }

  // -- 有界等待 -------------------------------------------------------------

  /** 等待任务终态；超时返回 null（不是失败）。 */
  async wait(taskId: string, maxWaitMs: number): Promise<BgTask | null> {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`未找到后台任务 ${taskId}（用 bg_list 查看现有任务）`);
    if (task.status !== 'running') return task;
    const bounded = Math.max(1, Math.min(maxWaitMs, BG_WAIT_MAX_MS));
    return await new Promise<BgTask | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null;
        const i = task.finalizeWaiters.indexOf(wake);
        if (i >= 0) task.finalizeWaiters.splice(i, 1); // 超时离场：不留已失效 waiter
        resolve(null);
      }, bounded);
      timer.unref?.();
      const wake = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(task);
      };
      task.finalizeWaiters.push(wake);
    });
  }

  // -- 通知管线（聚合 + 投递 + 滞留补发） ------------------------------------

  private _notify(task: BgTask, text: string): void {
    this._pendingNotify.push({ taskId: task.id, text });
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        void this._flushPending();
      }, BG_AGGREGATION_WINDOW_MS);
      this._flushTimer.unref?.();
    }
  }

  private async _flushPending(): Promise<void> {
    const batch = this._pendingNotify;
    this._pendingNotify = [];
    if (batch.length === 0) return;
    const text = batch.map((n) => n.text).join('\n\n---\n\n');
    const lastTaskId = batch[batch.length - 1].taskId;
    try {
      await this._deliverImpl(text, lastTaskId);
    } catch {
      // 投递失败：滞留到各任务，bg_status 时补发（通知契约的信任底线）。
      for (const n of batch) {
        this._tasks.get(n.taskId)?.unsent.push(n.text);
      }
    }
  }

  private async _httpDeliver(text: string, sourceRef: string): Promise<void> {
    const res = await fetch(
      `${this._viewerUrl}/api/agents/${encodeURIComponent(this._agentId)}/user-turn`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          source: 'shell',
          sourceRef,
          metadata: { shell: { taskId: sourceRef } },
        }),
        signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      throw new Error(`viewer user-turn delivery failed: HTTP ${res.status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 前台运行（固定预算 + 超时转后台）
// ---------------------------------------------------------------------------

export interface ForegroundRunOptions extends BgSpawnOptions {
  command: string;
  /** 前台预算（毫秒）。 */
  budgetMs: number;
  /** 框架 executor 的合并 signal（用户打断与框架超时共用）。 */
  signal?: AbortSignal;
  /**
   * 终止原因查询（executor 注入）：'timeout' 等系统原因 → 转后台继续跑；
   * 'user' 或缺省（无法判定）→ kill + drain（ADR-0005 现状语义，用户打断即停）。
   */
  termination?: () => string | null;
  /**
   * 终止 settle 截止（executor 注入，TOOL_TERMINATION_SETTLE_MS 契约）：
   * kill 后的 drain 预算按它裁剪，保证在宽限期内 resolve（否则 executor 判
   * ToolInterruptError，部分输出丢失）。
   */
  terminationDeadline?: () => number | null;
}

export interface ForegroundRunResult {
  outcome: ForegroundOutcome;
  /** 超时转后台时收养的任务句柄；否则 null。 */
  adoptedTask: BgTask | null;
}

/**
 * 前台语义的运行核心：spawn + 收集，budget/signal 触发时不 kill 而是收养进
 * 登记表（ADR-0005 中断即结果——中断的结果是"已转后台"）。
 *
 * 调用方负责把 adoptedTask 渲染为转后台文案；completed 分支由调用方按现状
 * 截断语义格式化（见 formatForegroundOutput）。
 */
export function runForegroundWithBudget(
  opts: ForegroundRunOptions,
  adopt: (child: ChildProcess, preOutput: { stdout: string; stderr: string }) => BgTask,
): Promise<ForegroundRunResult> {
  const child = spawnBackgroundProcess(opts.command, opts);
  let stdout = '';
  let stderr = '';
  let settled = false;
  let selfTimedOut = false;
  let terminating = false;
  const startedAt = Date.now();

  return new Promise<ForegroundRunResult>((resolve) => {
    const stdoutListener = (d: Buffer | string) => { stdout += d.toString(); };
    const stderrListener = (d: Buffer | string) => { stderr += d.toString(); };
    const detachCollectors = () => {
      // 转后台前先摘闭包收集器，避免与 registry 的收集并存泄漏（长任务全量输出）。
      child.stdout?.removeListener('data', stdoutListener);
      child.stderr?.removeListener('data', stderrListener);
    };

    // 直调（无 executor 计时）场景的自兜底：预算到点自行触发超时路径；
    // 经 executor 调用时 executor 先 abort，此定时器在 finish 中清除。
    let budgetTimer: ReturnType<typeof setTimeout> | null = opts.budgetMs > 0
      ? setTimeout(() => { selfTimedOut = true; onAbort(); }, opts.budgetMs)
      : null;
    budgetTimer?.unref?.();

    const finish = (outcome: ForegroundOutcome, adopted: BgTask | null) => {
      if (settled) return;
      settled = true;
      if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = null; }
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ outcome, adoptedTask: adopted });
    };

    const drainBudgetMs = () => {
      // 宽限期（executor TOOL_TERMINATION_SETTLE_MS=1s）内必须 resolve；缺省 800ms
      // 给 settle 留调度余量（drain 用满 1s 会输给 executor 的竞速）。
      const deadline = opts.terminationDeadline?.() ?? null;
      return deadline === null ? 800 : Math.max(0, Math.min(800, deadline - Date.now()));
    };

    const killAndTerminate = (reason: string) => {
      // 收集器保持挂着：drain 期间的残余输出继续进闭包（部分输出语义）。
      // terminating 标记让主 close listener 让路——kill 触发的 close 属于终止
      // 收集路径，若被 completed 分支抢答（taskkill 后退出码非 0）会覆盖
      // terminated 结果。
      terminating = true;
      try { makeKillChild(child)(); } catch { /* 已退出 */ }
      void drainToEof(child, drainBudgetMs()).then(() => {
        finish({
          kind: 'terminated',
          stdout,
          stderr,
          reason,
          durationMs: Date.now() - startedAt,
        }, null);
      });
    };

    const onAbort = () => {
      if (terminating || settled) return; // 终止路径已接管：预算兜底/重复 abort 不抢答
      const reason = selfTimedOut ? 'timeout' : (opts.termination?.() ?? 'user');
      if (reason === 'user') {
        // 用户主动打断即停（ADR-0005 终止收集语义）：kill 进程树 → drain → 部分输出。
        killAndTerminate(reason);
        return;
      }
      // 系统超时兜底：不 kill，收养继续跑。收养失败（如未配置 registry）必须
      // 退回终止语义——listener 内异常逃逸会让 execute 挂死或以残缺输出假成功。
      try {
        const task = adopt(child, { stdout, stderr });
        detachCollectors(); // adopt 成功后再摘闭包收集器（同步窗口无输出事件）
        finish({ kind: 'aborted', stdout, stderr }, task);
      } catch (err) {
        console.error('[shell] 转后台收养失败，退回终止语义:', err);
        killAndTerminate(reason);
      }
    };

    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', stdoutListener);
    child.stderr?.on('data', stderrListener);
    child.on('error', (err) => {
      if (terminating) return;
      stderr += `\n[进程错误] ${String(err)}`;
      finish({ kind: 'completed', code: -1, stdout, stderr }, null);
    });
    child.on('close', (code) => {
      if (terminating) return; // kill 后的 close 由终止收集路径消费
      finish({ kind: 'completed', code: code ?? -1, stdout, stderr }, null);
    });
  });
}

/**
 * 前台完成结果的截断格式化——对齐 runCollectedProcess 既有语义：
 * code=0 时 stdout/stderr 独立截断；非 0 时合并（'--- stderr ---' 分隔）后统一截断。
 * ok=false 由调用方以 reject 表达（现状语义）。
 */
export async function formatForegroundOutput(
  code: number,
  stdout: string,
  cleanStderr: string,
  workdir: string,
): Promise<{ ok: boolean; text: string }> {
  if (code === 0) {
    const [t1] = await processOutputWithPersistence(stdout || '', workdir);
    const [t2] = await processOutputWithPersistence(cleanStderr || '', workdir);
    return { ok: true, text: t1 || t2 };
  }
  const combined = [stdout, cleanStderr].filter(Boolean).join('\n\n--- stderr ---\n');
  const [t] = await processOutputWithPersistence(combined, workdir);
  return { ok: false, text: t };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs ? `${rs}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** 模型声明值必须是有限数值（NaN 会让 setTimeout 按 0 延迟处理，形成汇报风暴）。 */
function mustFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} 必须是有限数值（收到 ${String(value)}）`);
  }
  return value;
}

/** bash 家族共用的 stderr 噪音清理（job control / process group 提示）。 */
export function cleanBashStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter(line => !line.includes('process group') && !line.includes('job control'))
    .join('\n')
    .trim();
}
