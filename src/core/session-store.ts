import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { cwd } from 'process';
import type { ContextSnapshot } from './context.js';
import type { FeatureCheckpoint } from './checkpoint.js';
import type { UsageStatsSnapshot } from './usage.js';

export interface AgentRuntimeSnapshot {
  initialized: boolean;
  callIndex: number;
  context?: ContextSnapshot;
  featureStates: FeatureCheckpoint[];
  usageStats?: UsageStatsSnapshot;
}

export interface CallRollbackSnapshot {
  callIndex: number;
  draftInput: string;
  runtime: AgentRuntimeSnapshot;
}

/**
 * 命名检查点 — 由 Agent 自主建立的可恢复快照
 *
 * 与 CallRollbackSnapshot 的区别：
 * - CallRollbackSnapshot 面向"回到某个用户 call 之前"，是 onCall 的副产品
 * - NamedCheckpoint 面向"Agent 主动建立的恢复点"，有稳定 ID，可跨 segment 引用
 *
 * checkpoint 表示控制工具执行完成、tool result 已写入、
 * 当前 segment 已完全结束之后的 runtime 状态（协议完整）。
 */
export interface NamedCheckpoint {
  /** 全局唯一的 checkpoint ID（由 Agent 提供） */
  id: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 创建时的 callIndex */
  sourceCallIndex: number;
  /** 完整的 runtime snapshot */
  runtime: AgentRuntimeSnapshot;
}

export interface AgentSessionSnapshot {
  version: number;
  sessionId: string;
  savedAt: number;
  agentType: string;
  runtime: AgentRuntimeSnapshot;
  rollbackHistory: CallRollbackSnapshot[];
  /** 命名检查点列表（可选，用于 checkpoint/rollback 能力） */
  namedCheckpoints?: NamedCheckpoint[];
}

export interface SessionStore {
  save(sessionId: string, snapshot: AgentSessionSnapshot): Promise<string>;
  load(sessionId: string): Promise<AgentSessionSnapshot>;
  list(): Promise<string[]>;
  delete(sessionId: string): Promise<void>;
}

const DEFAULT_SESSION_DIR = resolve(cwd(), '.agentdev', 'sessions');

export class FileSessionStore implements SessionStore {
  constructor(private readonly baseDir: string = DEFAULT_SESSION_DIR) {}

  async save(sessionId: string, snapshot: AgentSessionSnapshot): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });
    const filePath = this.resolvePath(sessionId);
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    return filePath;
  }

  async load(sessionId: string): Promise<AgentSessionSnapshot> {
    const filePath = this.resolvePath(sessionId);
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as AgentSessionSnapshot;
  }

  async list(): Promise<string[]> {
    await mkdir(this.baseDir, { recursive: true });
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.replace(/\.json$/i, ''))
      .sort();
  }

  async delete(sessionId: string): Promise<void> {
    await rm(this.resolvePath(sessionId), { force: true });
  }

  private resolvePath(sessionId: string): string {
    return resolve(this.baseDir, `${sessionId}.json`);
  }
}

let defaultSessionStore: SessionStore | undefined;

export function getDefaultSessionStore(): SessionStore {
  if (!defaultSessionStore) {
    defaultSessionStore = new FileSessionStore();
  }
  return defaultSessionStore;
}
