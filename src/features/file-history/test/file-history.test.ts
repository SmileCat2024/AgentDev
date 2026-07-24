import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createInitialState,
  trackEdit,
  makeSnapshot,
  getDiffStats,
  type FileHistoryState,
} from '../file-history.js';
import { FileHistoryFeature } from '../index.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('FileHistoryFeature', () => {
  describe('initialization', () => {
    it('should have correct name', () => {
      const f = new FileHistoryFeature();
      expect(f.name).toBe('file-history');
    });

    it('should have no dependencies', () => {
      const f = new FileHistoryFeature();
      expect(f.dependencies).toEqual([]);
    });

    it('should have correct description', () => {
      const f = new FileHistoryFeature();
      expect(f.description).toContain('文件修改历史');
    });

    it('should accept workspaceDir config', () => {
      const f = new FileHistoryFeature({ workspaceDir: '/tmp/test' });
      expect(f).toBeDefined();
    });
  });

  describe('uninitialized state', () => {
    it('should return empty snapshot list before init', () => {
      const f = new FileHistoryFeature();
      expect(f.getSnapshotList()).toEqual([]);
    });

    it('should return 0 tracked file count before init', () => {
      const f = new FileHistoryFeature();
      expect(f.getTrackedFileCount()).toBe(0);
    });

    it('should return 0 snapshot count before init', () => {
      const f = new FileHistoryFeature();
      expect(f.getSnapshotCount()).toBe(0);
    });

    it('captureState should return null before init', () => {
      const f = new FileHistoryFeature();
      expect(f.captureState()).toBeNull();
    });

    it('getDiffStats should return empty stats before init', async () => {
      const f = new FileHistoryFeature();
      const stats = await f.getDiffStats(0);
      expect(stats.filesChanged).toEqual([]);
      expect(stats.insertions).toBe(0);
      expect(stats.deletions).toBe(0);
    });
  });

  describe('captureState() / restoreState()', () => {
    it('should capture state after init', async () => {
      const f = new FileHistoryFeature({ workspaceDir: '/tmp' });
      await f.onInitiate({
        agentId: 'test',
        config: {} as any,
        logger: { info: vi.fn() } as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });

      const snapshot = f.captureState();
      expect(snapshot).not.toBeNull();
      expect((snapshot as any).sessionId).toBeDefined();
      expect((snapshot as any).snapshots).toEqual([]);
    });

    it('should restore state with correct fields', async () => {
      const f = new FileHistoryFeature({ workspaceDir: '/tmp' });
      await f.onInitiate({
        agentId: 'test',
        config: {} as any,
        logger: { info: vi.fn() } as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });

      const snapshot = f.captureState();
      const f2 = new FileHistoryFeature({ workspaceDir: '/tmp' });
      f2.restoreState(snapshot!);
      expect(f2.getSnapshotCount()).toBe(0);
    });

    it('should handle restoreState with null', () => {
      const f = new FileHistoryFeature();
      f.restoreState(null as any);
      // Should not throw, state remains null
      expect(f.getSnapshotList()).toEqual([]);
    });

    it('should handle restoreState with incomplete data', () => {
      const f = new FileHistoryFeature();
      f.restoreState({ snapshots: [] } as any);
      // Should not crash
      expect(f.getSnapshotList()).toEqual([]);
    });
  });

  describe('onDestroy', () => {
    it('should clear state on destroy', async () => {
      const f = new FileHistoryFeature({ workspaceDir: '/tmp' });
      await f.onInitiate({
        agentId: 'test',
        config: {} as any,
        logger: { info: vi.fn() } as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });

      await f.onDestroy({
        agentId: 'test',
        config: {} as any,
        getFeature: () => undefined,
      });

      expect(f.captureState()).toBeNull();
    });
  });
});

// ========== Core logic (file-history.ts) ==========

describe('file-history.ts core logic', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `fh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('createInitialState()', () => {
    it('should create state with empty snapshots', () => {
      const state = createInitialState('session-1', tempDir);
      expect(state.snapshots).toEqual([]);
      expect(state.trackedFiles).toEqual([]);
      expect(state.snapshotCounter).toBe(0);
      expect(state.sessionId).toBe('session-1');
      expect(state.workspaceDir).toBe(tempDir);
    });
  });

  describe('trackEdit()', () => {
    it('should skip when no snapshots exist', async () => {
      const state = createInitialState('session-1', tempDir);
      const newState = await trackEdit(state, join(tempDir, 'test.txt'));
      expect(newState).toBe(state); // unchanged
    });

    it('should create backup when snapshot exists', async () => {
      const filePath = join(tempDir, 'test.txt');
      writeFileSync(filePath, 'original content');

      let state = createInitialState('session-1', tempDir);
      state = await makeSnapshot(state);
      state = await trackEdit(state, filePath);

      expect(state.trackedFiles).toContain('test.txt');
      expect(state.snapshots[0].trackedFileBackups['test.txt']).toBeDefined();
      expect(state.snapshots[0].trackedFileBackups['test.txt'].version).toBe(1);
    });

    it('should skip duplicate track in same snapshot', async () => {
      const filePath = join(tempDir, 'test.txt');
      writeFileSync(filePath, 'original content');

      let state = createInitialState('session-1', tempDir);
      state = await makeSnapshot(state);
      state = await trackEdit(state, filePath);

      // Track again — should skip
      const state2 = await trackEdit(state, filePath);
      expect(state2).toBe(state); // same reference returned
    });
  });

  describe('makeSnapshot()', () => {
    it('should create first snapshot with empty tracked files', async () => {
      let state = createInitialState('session-1', tempDir);
      state = await makeSnapshot(state);

      expect(state.snapshots).toHaveLength(1);
      expect(state.snapshots[0].id).toBe(0);
      expect(state.snapshotCounter).toBe(1);
    });

    it('should increment snapshotCounter', async () => {
      let state = createInitialState('session-1', tempDir);
      state = await makeSnapshot(state);
      state = await makeSnapshot(state);

      expect(state.snapshots).toHaveLength(2);
      expect(state.snapshots[0].id).toBe(0);
      expect(state.snapshots[1].id).toBe(1);
      expect(state.snapshotCounter).toBe(2);
    });
  });

  describe('getDiffStats()', () => {
    it('should return empty for non-existent snapshot', async () => {
      const state = createInitialState('session-1', tempDir);
      const stats = await getDiffStats(state, 999);
      expect(stats.filesChanged).toEqual([]);
      expect(stats.insertions).toBe(0);
      expect(stats.deletions).toBe(0);
    });
  });
});
