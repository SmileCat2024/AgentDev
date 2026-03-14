import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { cwd } from 'process';
import type { ContextSnapshot } from './context.js';
import type { FeatureCheckpoint } from './checkpoint.js';

export interface AgentRuntimeSnapshot {
  initialized: boolean;
  callIndex: number;
  context?: ContextSnapshot;
  featureStates: FeatureCheckpoint[];
}

export interface CallRollbackSnapshot {
  callIndex: number;
  draftInput: string;
  runtime: AgentRuntimeSnapshot;
}

export interface AgentSessionSnapshot {
  version: number;
  sessionId: string;
  savedAt: number;
  agentType: string;
  runtime: AgentRuntimeSnapshot;
  rollbackHistory: CallRollbackSnapshot[];
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
