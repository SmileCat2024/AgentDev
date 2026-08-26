/**
 * WorkThreadStore — WorkThread 锚点层持久化存储
 *
 * 移植自 Claw `server/thread-control/thread-store.js`（原子写 / per-thread 串行锁 /
 * revision 乐观并发），只保留锚点层字段——sessionChain / head / pendingSuccession /
 * commands / hold / 接续编排状态（open / rotating / rotation_failed / closed）。
 *
 * 执行调度看板字段（executionEvents / mode / idle–failed 状态）不在此文件；
 * 那是可选 WorkThreadBoard 的持久化域，见 board.ts。本模块 import 面不含看板状态值。
 *
 * 设计要点：
 * - 每个 WorkThread 一个 JSON 文件（thread 记录 + inbox commands + hold），
 *   保证「head 推进 + 指令状态变更 + 挡板清除」可以在同一次原子写内完成。
 * - index.json 仅保存列表摘要，供轻量列举。
 * - 所有写操作走 per-thread 串行锁 + revision 自增 + tmp/rename 原子写。
 * - 支持 expectedRevision 乐观并发控制（head 推进等关键事务使用）。
 *
 * 数据目录由构造时必传 rootDir（框架不定义默认根，宿主决定归属规模）。
 * 并发模型：per-thread 串行锁只在单宿主进程内成立；多宿主进程共用同一数据
 * 目录时未定义，当前单宿主前提下接受（ADR-0002 后果项）。
 */

import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { WorkThreadCommand } from './inbox.js';

export interface WorkThreadChainEntry {
  sessionId: string;
  role: 'head' | 'predecessor';
  startedAt: number;
  endedAt: number | null;
  endKind: string | null;
  successorSessionId: string | null;
}

/** 交接意图（pendingSuccession）单一真相、落盘。 */
export interface WorkThreadPendingSuccession {
  fromSessionId: string;
  reason: string;
  stage: string;
  startedAt: number;
}

/** 锚点层接续编排状态。执行调度状态机（看板执行态）归看板层。 */
export type WorkThreadStatus = 'open' | 'rotating' | 'rotation_failed' | 'closed';

export interface WorkThreadLifecycleEvent {
  type: string;
  status: string;
  at: number;
  [key: string]: unknown;
}

export interface WorkThreadRecord {
  threadId: string;
  agentId: string;
  workspaceId?: string;
  title?: string;
  status: WorkThreadStatus;
  /**
   * 线程的产品身份归属（T001：身份连续性不变量的事实来源）。
   * 新建线程时从 root Session 解析确定；`null` = 身份未知（历史数据缺少
   * 该字段时的读时归一值——明确「未知」，绝不静默回填为任何具体身份）。
   */
  identity?: string | null;
  rootSessionId: string;
  headSessionId: string;
  sessionChain: WorkThreadChainEntry[];
  commands: WorkThreadCommand[];
  pendingSuccession: WorkThreadPendingSuccession | null;
  /** 宿主级「暂停投递」落盘第一等布尔开关（重启不丢）。 */
  hold: boolean;
  closedAt?: number;
  closeReason?: string;
  lifecycleEvents: WorkThreadLifecycleEvent[];
  lastLifecycleEvent: WorkThreadLifecycleEvent | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export class WorkThreadNotFoundError extends Error {
  readonly code = 'workthread_not_found';
  constructor(threadId: string) {
    super(`WorkThread "${threadId}" not found`);
    this.name = 'WorkThreadNotFoundError';
  }
}

export class WorkThreadRevisionConflictError extends Error {
  readonly code = 'revision_conflict';
  readonly expected: number;
  readonly actual: number;
  constructor(threadId: string, expected: number, actual: number) {
    super(`Revision conflict on workthread "${threadId}": expected ${expected}, current ${actual}`);
    this.name = 'WorkThreadRevisionConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

export function generateWorkThreadId(): string {
  return `wt-${randomUUID()}`;
}

/**
 * 线程 id 用于文件名：清除非法字符，防止路径穿越。
 * 与 Claw shared/string-helpers.sanitizeSessionFragment 逐字节一致。
 */
export function sanitizeWorkThreadFragment(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function threadContentSignature(record: WorkThreadRecord): string {
  const { revision: _revision, updatedAt: _updatedAt, ...rest } = record;
  return JSON.stringify(rest);
}

// 旧状态空间（active/completed/cancelled/blocked）的读时归一，映射到新锚点域。
// 盘上旧值不允许流入控制器，下次写盘会自动落成新值。
const LEGACY_STATUS_MAP: Record<string, WorkThreadStatus> = {
  active: 'open',
  completed: 'closed',
  cancelled: 'closed',
  blocked: 'open',
};

function normalizeThreadRecord(record: WorkThreadRecord): WorkThreadRecord {
  if (record && typeof record === 'object') {
    if (LEGACY_STATUS_MAP[record.status]) {
      record.status = LEGACY_STATUS_MAP[record.status];
    }
    // T001 身份归属读时归一：缺失 / 空串统一为 null（身份未知）。
    // 不可静默把历史线程成员当成 main——未知是明确的机器可判定状态。
    record.identity =
      typeof record.identity === 'string' && record.identity.trim()
        ? record.identity.trim()
        : null;
  }
  return record;
}

export interface WorkThreadStoreOptions {
  rootDir: string;
}

export class WorkThreadStore {
  readonly rootDir: string;
  readonly threadsDir: string;
  readonly indexPath: string;
  private _threadLocks = new Map<string, Promise<void>>();
  private _indexLock: Promise<void> = Promise.resolve();

  constructor({ rootDir }: WorkThreadStoreOptions) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new Error('WorkThreadStore requires a rootDir');
    }
    this.rootDir = rootDir;
    this.threadsDir = join(rootDir, 'threads');
    this.indexPath = join(rootDir, 'index.json');
  }

  // ── 路径 ──────────────────────────────────────────────────────────

  private threadFilePath(threadId: string): string {
    return join(this.threadsDir, `${sanitizeWorkThreadFragment(threadId)}.json`);
  }

  // ── 原子写（对齐 FileSessionStore 模式，兼容 Windows EPERM/EXDEV）─

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

  // ── index（列表摘要）─────────────────────────────────────────────

  private async readIndex(): Promise<{ revision: number; threads: unknown[] }> {
    try {
      const raw = JSON.parse(await readFile(this.indexPath, 'utf8')) as {
        revision?: number;
        threads?: unknown[];
      };
      const threads = Array.isArray(raw.threads) ? raw.threads : [];
      return {
        revision:
          Number.isSafeInteger(Number(raw.revision)) && Number(raw.revision) >= 0
            ? Number(raw.revision)
            : 0,
        threads,
      };
    } catch {
      return { revision: 0, threads: [] };
    }
  }

  private async writeIndex(index: unknown): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.atomicWriteJson(this.indexPath, index);
  }

  private async updateIndexEntry(record: WorkThreadRecord): Promise<void> {
    const prev = this._indexLock;
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this._indexLock = next;
    await prev.catch(() => {});
    try {
      const index = await this.readIndex();
      const entry = {
        threadId: record.threadId,
        agentId: record.agentId,
        workspaceId: record.workspaceId || '',
        title: record.title || '',
        status: LEGACY_STATUS_MAP[record.status] || record.status || 'open',
        rootSessionId: record.rootSessionId || '',
        headSessionId: record.headSessionId || '',
        // T001：线程身份归属（轻量事实，供成员/head 查询统一取用）；
        // 旧记录缺字段时为 null（身份未知，前端不得据此默认渲染）。
        identity: typeof record.identity === 'string' && record.identity.trim()
          ? record.identity.trim()
          : null,
        // 链成员 id 列表（轻量，供前端徽标判定「会话是否属于线程」）
        sessionIds: (Array.isArray(record.sessionChain) ? record.sessionChain : []).map(
          (entry) => entry?.sessionId || '',
        ).filter(Boolean),
        // 每棒接力边（轻量，供前端接力分隔条渲染）：非 root 会话的来源与方式
        chainEdges: buildChainEdges(record),
        // 交接意图原始时间戳（0 = 无）；fresh 与否由读取方按统一规则派生
        handoffStartedAt: Number(record.pendingSuccession?.startedAt) || 0,
        handoffStage: record.pendingSuccession?.stage || null,
        hold: record.hold === true,
        lastLifecycleEvent: record.lastLifecycleEvent || null,
        // pending 指令文本预览（轻量，上限 5 条）
        pendingTexts: (Array.isArray(record.commands) ? record.commands : [])
          .filter((c) => c?.status === 'pending')
          .slice(0, 5)
          .map((c) => String(c?.text || '').slice(0, 120)),
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      const existingIdx = (index.threads as Array<{ threadId?: string }>).findIndex(
        (t) => t?.threadId === record.threadId,
      );
      if (existingIdx >= 0) {
        (index.threads as unknown[])[existingIdx] = entry;
      } else {
        index.threads.push(entry as unknown);
      }
      index.revision = (Number(index.revision) || 0) + 1;
      await this.writeIndex(index);
    } finally {
      release();
    }
  }

  // ── 读 ───────────────────────────────────────────────────────────

  async list(): Promise<unknown[]> {
    const index = await this.readIndex();
    return index.threads;
  }

  async get(threadId: string): Promise<WorkThreadRecord | null> {
    if (!threadId || typeof threadId !== 'string') return null;
    try {
      const parsed = JSON.parse(
        await readFile(this.threadFilePath(threadId), 'utf8'),
      ) as WorkThreadRecord;
      return normalizeThreadRecord(parsed);
    } catch {
      return null;
    }
  }

  // ── 写 ───────────────────────────────────────────────────────────

  /** 创建线程记录。要求调用方已构建完整初始记录。 */
  async create(record: WorkThreadRecord): Promise<WorkThreadRecord> {
    const threadId = record?.threadId;
    if (!threadId) throw new Error('WorkThreadStore.create requires record.threadId');
    await mkdir(this.threadsDir, { recursive: true });
    const existing = await this.get(threadId);
    if (existing) {
      throw new Error(`WorkThread "${threadId}" already exists`);
    }
    const normalized = normalizeThreadRecord(record);
    await this.atomicWriteJson(this.threadFilePath(threadId), normalized);
    await this.updateIndexEntry(normalized);
    return normalized;
  }

  /**
   * 串行化更新单个线程记录。
   * @param expectedRevision 乐观并发检查
   * @returns {changed} 无内容变更（元数据更新）时 false，revision 不递增
   */
  async update(
    threadId: string,
    mutFn: (
      record: WorkThreadRecord,
    ) => WorkThreadRecord | null | undefined | Promise<WorkThreadRecord | null | undefined>,
    options: { expectedRevision?: number } = {},
  ): Promise<{ record: WorkThreadRecord; changed: boolean }> {
    const prev = this._threadLocks.get(threadId) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this._threadLocks.set(threadId, next);
    await prev.catch(() => {});
    try {
      const record = await this.get(threadId);
      if (!record) {
        throw new WorkThreadNotFoundError(threadId);
      }
      if (Number.isInteger(options.expectedRevision) && record.revision !== options.expectedRevision) {
        throw new WorkThreadRevisionConflictError(
          threadId,
          options.expectedRevision as number,
          record.revision,
        );
      }

      const before = threadContentSignature(record);
      const proposed = await mutFn(record);
      if (!proposed || typeof proposed !== 'object') {
        throw new Error('WorkThreadStore.update mutFn must return the record');
      }
      const after = threadContentSignature(proposed);

      if (after === before) {
        return { record, changed: false };
      }

      const nextRecord: WorkThreadRecord = {
        ...proposed,
        revision: (Number(record.revision) || 0) + 1,
        updatedAt: Date.now(),
      };
      await this.atomicWriteJson(this.threadFilePath(threadId), nextRecord);
      await this.updateIndexEntry(nextRecord);
      return { record: nextRecord, changed: true };
    } finally {
      release();
      if (this._threadLocks.get(threadId) === next) this._threadLocks.delete(threadId);
    }
  }
}

function buildChainEdges(record: WorkThreadRecord): Array<{
  sessionId: string;
  fromSessionId: string;
  relayKind: string;
}> {
  const chain = Array.isArray(record.sessionChain) ? record.sessionChain : [];
  const bySuccessor = new Map<string, WorkThreadChainEntry>();
  for (const entry of chain) {
    if (entry?.successorSessionId && entry?.sessionId) {
      bySuccessor.set(entry.successorSessionId, entry);
    }
  }
  return chain
    .filter((entry) => entry?.sessionId && entry.sessionId !== record.rootSessionId)
    .map((entry) => {
      const pred = bySuccessor.get(entry.sessionId);
      return {
        sessionId: entry.sessionId,
        fromSessionId: pred?.sessionId || '',
        relayKind: pred?.endKind || '',
      };
    });
}
