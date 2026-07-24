import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryFeature } from '../index.js';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MemoryFeature', () => {
  let feature: MemoryFeature;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ========== 初始化 ==========

  describe('initialization', () => {
    it('should have correct name', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      expect(feature.name).toBe('memory');
    });

    it('should have no dependencies', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      expect(feature.dependencies).toEqual([]);
    });

    it('should default to CLAUDE.md and AGENT.md', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      // No tools, no templates
      expect(feature.getTemplateNames()).toEqual([]);
    });

    it('should accept custom documents', () => {
      feature = new MemoryFeature({
        workspaceDir: tempDir,
        documents: ['RULES.md'],
      });
      expect(feature).toBeDefined();
    });

    it('should accept resourceRoot', () => {
      feature = new MemoryFeature({
        resourceRoot: tempDir,
        documents: ['CLAUDE.md'],
      });
      expect(feature).toBeDefined();
    });
  });

  // ========== 工具 ==========

  describe('getTools()', () => {
    it('should return no tools (MemoryFeature has no tools)', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      const tools = feature.getTools?.() ?? [];
      expect(tools).toEqual([]);
    });
  });

  // ========== captureState / restoreState ==========

  describe('captureState() / restoreState()', () => {
    it('should capture injected=false initially', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      const snapshot = feature.captureState() as { injected: boolean };
      expect(snapshot.injected).toBe(false);
    });

    it('should restore injected state', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      feature.restoreState({ injected: true });
      const snapshot = feature.captureState() as { injected: boolean };
      expect(snapshot.injected).toBe(true);
    });

    it('should handle restoreState with missing injected field', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      feature.restoreState({});
      const snapshot = feature.captureState() as { injected: boolean };
      expect(snapshot.injected).toBe(false);
    });

    it('should handle restoreState with null', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      feature.restoreState(null as any);
      const snapshot = feature.captureState() as { injected: boolean };
      expect(snapshot.injected).toBe(false);
    });
  });

  // ========== Feature Manifest ==========

  describe('getFeatureManifest()', () => {
    it('should return manifest with settings', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      const manifest = feature.getFeatureManifest();
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.settings.properties).toBeDefined();
      expect(manifest.settings.properties.readClaudeMd).toBeDefined();
      expect(manifest.settings.properties.readAgentMd).toBeDefined();
      expect(manifest.settings.properties.extraDocs).toBeDefined();
    });
  });

  // ========== getHookDescription ==========

  describe('getHookDescription()', () => {
    it('should return description for CallStart/injectCLAUDEContent', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      const desc = feature.getHookDescription('CallStart', 'injectCLAUDEContent');
      expect(desc).toBeDefined();
      expect(desc).toContain('项目文档');
    });

    it('should return undefined for unknown hook', () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });
      const desc = feature.getHookDescription('StepStart', 'unknown');
      expect(desc).toBeUndefined();
    });
  });

  // ========== 文档注入逻辑 ==========

  describe('document injection (via mock context)', () => {
    it('should read CLAUDE.md from workspaceDir when it exists', async () => {
      // Create a CLAUDE.md in temp dir
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Project Rules\nBe careful with files.');

      feature = new MemoryFeature({ workspaceDir: tempDir });

      // Mock CallStart context
      const messages: Array<{ role: string; content: string }> = [];
      const mockContext = {
        context: {
          add: (msg: { role: string; content: string }) => messages.push(msg),
        },
        isFirstCall: true,
      };

      // Access the private method through the decorated method
      await (feature as any).injectCLAUDEContent(mockContext);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Project Rules');
    });

    it('should not inject when no document files exist', async () => {
      feature = new MemoryFeature({ workspaceDir: tempDir });

      const messages: Array<{ role: string; content: string }> = [];
      const mockContext = {
        context: {
          add: (msg: { role: string; content: string }) => messages.push(msg),
        },
        isFirstCall: true,
      };

      await (feature as any).injectCLAUDEContent(mockContext);
      expect(messages).toHaveLength(0);
    });

    it('should not inject on non-first call', async () => {
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Rules');

      feature = new MemoryFeature({ workspaceDir: tempDir });

      const messages: Array<{ role: string; content: string }> = [];
      const mockContext = {
        context: {
          add: (msg: { role: string; content: string }) => messages.push(msg),
        },
        isFirstCall: false,
      };

      await (feature as any).injectCLAUDEContent(mockContext);
      expect(messages).toHaveLength(0);
    });

    it('should not inject twice', async () => {
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Rules');

      feature = new MemoryFeature({ workspaceDir: tempDir });

      const messages: Array<{ role: string; content: string }> = [];
      const mockContext = {
        context: {
          add: (msg: { role: string; content: string }) => messages.push(msg),
        },
        isFirstCall: true,
      };

      // First call — injects
      await (feature as any).injectCLAUDEContent(mockContext);
      expect(messages).toHaveLength(1);

      // Second call — skipped because _injected is true
      await (feature as any).injectCLAUDEContent(mockContext);
      expect(messages).toHaveLength(1);
    });

    it('should skip empty content files', async () => {
      writeFileSync(join(tempDir, 'CLAUDE.md'), '   \n\t\n  ');

      feature = new MemoryFeature({ workspaceDir: tempDir });

      const messages: Array<{ role: string; content: string }> = [];
      const mockContext = {
        context: {
          add: (msg: { role: string; content: string }) => messages.push(msg),
        },
        isFirstCall: true,
      };

      await (feature as any).injectCLAUDEContent(mockContext);
      expect(messages).toHaveLength(0);
    });

    it('should inject multiple documents', async () => {
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Claude Rules');
      writeFileSync(join(tempDir, 'AGENT.md'), '# Agent Rules');

      feature = new MemoryFeature({ workspaceDir: tempDir });

      const messages: Array<{ role: string; content: string }> = [];
      const mockContext = {
        context: {
          add: (msg: { role: string; content: string }) => messages.push(msg),
        },
        isFirstCall: true,
      };

      await (feature as any).injectCLAUDEContent(mockContext);
      expect(messages).toHaveLength(2);
    });
  });

  // ========== onInitiate ==========

  describe('onInitiate()', () => {
    it('should apply workspaceDir from config', async () => {
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Rules');

      feature = new MemoryFeature();
      await feature.onInitiate({
        agentId: 'test',
        config: { workspaceDir: tempDir } as any,
        logger: console as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });

      // After init, baseDir should be the workspaceDir from config
      const messages: Array<{ role: string; content: string }> = [];
      await (feature as any).injectCLAUDEContent({
        context: { add: (msg: any) => messages.push(msg) },
        isFirstCall: true,
      });
      expect(messages).toHaveLength(1);
    });

    it('should read featureConfig for document selection', async () => {
      writeFileSync(join(tempDir, 'CLAUDE.md'), '# Claude Rules');
      writeFileSync(join(tempDir, 'AGENT.md'), '# Agent Rules');

      feature = new MemoryFeature({ workspaceDir: tempDir });
      await feature.onInitiate({
        agentId: 'test',
        config: {} as any,
        logger: console as any,
        featureConfig: { readClaudeMd: true, readAgentMd: false },
        getFeature: () => undefined,
        registerTool: () => {},
      });

      const messages: Array<{ role: string; content: string }> = [];
      await (feature as any).injectCLAUDEContent({
        context: { add: (msg: any) => messages.push(msg) },
        isFirstCall: true,
      });
      // Only CLAUDE.md should be injected
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain('Claude Rules');
    });
  });
});
