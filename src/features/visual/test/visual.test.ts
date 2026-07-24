import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VisualFeature } from '../index.js';

describe('VisualFeature', () => {
  let feature: VisualFeature;

  beforeEach(() => {
    // Use checkPythonEnv: false to avoid spawning Python during tests
    feature = new VisualFeature({
      checkPythonEnv: false,
      enableWindowInfo: false,
    });
  });

  // ========== 初始化 ==========

  describe('initialization', () => {
    it('should have correct name', () => {
      expect(feature.name).toBe('visual');
    });

    it('should have no dependencies', () => {
      expect(feature.dependencies).toEqual([]);
    });

    it('should have correct description', () => {
      expect(feature.description).toContain('窗口截图');
    });

    it('should accept custom pythonPath config', () => {
      const f = new VisualFeature({
        pythonPath: 'python3',
        checkPythonEnv: false,
      });
      expect(f).toBeDefined();
    });

    it('should accept pythonArgs config', () => {
      const f = new VisualFeature({
        pythonPath: 'uv',
        pythonArgs: ['run', '--with', 'pywin32'],
        checkPythonEnv: false,
      });
      expect(f).toBeDefined();
    });

    it('should accept baseUrl and model config', () => {
      const f = new VisualFeature({
        baseUrl: 'http://custom:8080',
        model: 'custom-model',
        checkPythonEnv: false,
      });
      expect(f).toBeDefined();
    });

    it('should accept advancedVision config', () => {
      const f = new VisualFeature({
        advancedVision: {
          baseUrl: 'http://custom:8081',
          model: 'advanced-model',
        },
        checkPythonEnv: false,
      });
      expect(f).toBeDefined();
    });
  });

  // ========== 工具 ==========

  describe('getTools()', () => {
    it('should return empty array (tools are async)', () => {
      expect(feature.getTools()).toEqual([]);
    });
  });

  // ========== 模板 ==========

  describe('getTemplateNames()', () => {
    it('should return ["capture"]', () => {
      expect(feature.getTemplateNames()).toEqual(['capture']);
    });
  });

  // ========== getHookDescription ==========

  describe('getHookDescription()', () => {
    it('should return description for CallStart/injectWindowInfo', () => {
      const desc = feature.getHookDescription('CallStart', 'injectWindowInfo');
      expect(desc).toBeDefined();
      expect(desc).toContain('/visual');
    });

    it('should return undefined for unknown hook', () => {
      const desc = feature.getHookDescription('StepStart', 'unknown');
      expect(desc).toBeUndefined();
    });
  });

  // ========== captureState ==========

  describe('captureState()', () => {
    it('should capture visualEnabled=false initially', () => {
      const snapshot = feature.captureState() as any;
      expect(snapshot.visualEnabled).toBe(false);
    });

    it('should capture injectionState structure', () => {
      const snapshot = feature.captureState() as any;
      expect(snapshot.injectionState).toBeDefined();
      expect(snapshot.injectionState.isFirstInjection).toBe(true);
      expect(snapshot.injectionState.lastInjectedWindows).toBeInstanceOf(Array);
      expect(snapshot.injectionState.lastInjectedAnalyses).toBeInstanceOf(Array);
      expect(snapshot.injectionState.focusHistory).toEqual([]);
      expect(snapshot.injectionState.lastForegroundHwnd).toBeNull();
    });
  });

  // ========== restoreState ==========

  describe('restoreState()', () => {
    it('should restore visualEnabled', () => {
      feature.restoreState({
        visualEnabled: true,
        injectionState: {
          isFirstInjection: false,
          lastInjectedWindows: [['0x123', { title: 'Test', status: 'Normal', processPath: '/app', isForeground: true }]],
          lastInjectedAnalyses: [['0x123', 'hash1']],
          focusHistory: ['0x123'],
          lastForegroundHwnd: '0x123',
        },
      });
      const snapshot = feature.captureState() as any;
      expect(snapshot.visualEnabled).toBe(true);
      expect(snapshot.injectionState.isFirstInjection).toBe(false);
      expect(snapshot.injectionState.lastInjectedWindows).toHaveLength(1);
      expect(snapshot.injectionState.focusHistory).toEqual(['0x123']);
    });

    it('should handle restoreState with null/undefined fields', () => {
      feature.restoreState({});
      const snapshot = feature.captureState() as any;
      expect(snapshot.visualEnabled).toBe(false);
      expect(snapshot.injectionState.isFirstInjection).toBe(true);
    });

    it('should handle restoreState with null injectionState', () => {
      feature.restoreState({ injectionState: undefined });
      const snapshot = feature.captureState() as any;
      expect(snapshot.injectionState.isFirstInjection).toBe(true);
      expect(snapshot.injectionState.focusHistory).toEqual([]);
    });
  });

  // ========== Lifecycle ==========

  describe('lifecycle', () => {
    it('onInitiate should complete without error', async () => {
      await feature.onInitiate({
        agentId: 'test',
        config: {} as any,
        logger: console as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });
    });

    it('onDestroy should complete without error', async () => {
      await feature.onDestroy({
        agentId: 'test',
        config: {} as any,
        getFeature: () => undefined,
      });
    });
  });

  // ========== getAsyncTools ==========

  describe('getAsyncTools()', () => {
    it('should return 2 async tools', async () => {
      const tools = await feature.getAsyncTools({
        agentId: 'test',
        config: {} as any,
        logger: console as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name)).toContain('capture_and_understand_window');
      expect(tools.map(t => t.name)).toContain('capture_and_understand_window_advanced');
    });
  });

  // ========== captureState/restoreState round-trip ==========

  describe('captureState/restoreState round-trip', () => {
    it('should preserve state after round-trip', () => {
      // Capture initial state
      const snapshot1 = feature.captureState();

      // Modify state (simulate toggle)
      feature.restoreState({
        visualEnabled: true,
        injectionState: {
          isFirstInjection: false,
          lastInjectedWindows: [['win1', { title: 'A', status: 'Normal', processPath: '/a', isForeground: true }]],
          lastInjectedAnalyses: [['win1', 'abc...[10]']],
          focusHistory: ['win1'],
          lastForegroundHwnd: 'win1',
        },
      });

      // Capture again
      const snapshot2 = feature.captureState() as any;
      expect(snapshot2.visualEnabled).toBe(true);
      expect(snapshot2.injectionState.isFirstInjection).toBe(false);
      expect(snapshot2.injectionState.focusHistory).toEqual(['win1']);
    });
  });
});
