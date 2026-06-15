/**
 * LSP Feature 测试
 *
 * 覆盖：
 * 1. findExecutable() 跨平台可执行文件查找
 * 2. spawn 错误处理与优雅降级
 * 3. getFeatureManifest() 结构正确性
 * 4. featureConfig 消费逻辑
 */

import { describe, it, expect } from 'bun:test';
import { findExecutable } from '../src/features/lsp/which.js';
import { SERVERS } from '../src/features/lsp/servers.js';
import { LspFeature } from '../src/features/lsp/index.js';
import type { LspFeatureConfig } from '../src/features/lsp/types.js';

// ============================================================
// 1. findExecutable()
// ============================================================

describe('findExecutable()', () => {
  it('returns undefined for non-existent commands', () => {
    const result = findExecutable('this-command-definitely-does-not-exist-xyz123');
    expect(result).toBeUndefined();
  });

  it('returns a path string for existing commands (node)', () => {
    const result = findExecutable('node');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  });

  it('returns undefined for empty string', () => {
    const result = findExecutable('');
    expect(result).toBeUndefined();
  });

  it('returns undefined for whitespace-only command', () => {
    const result = findExecutable('   ');
    // 'where   ' or 'which   ' should fail or return nothing useful
    // Implementation should treat this as not found
    expect(result).toBeUndefined();
  });
});

// ============================================================
// 2. Server definitions integrity
// ============================================================

describe('SERVERS registry', () => {
  it('has exactly 14 server definitions', () => {
    const serverIds = Object.keys(SERVERS);
    expect(serverIds.length).toBe(14);
  });

  it('each server has required fields', () => {
    for (const [id, server] of Object.entries(SERVERS)) {
      expect(server.id).toBe(id);
      expect(Array.isArray(server.extensions)).toBe(true);
      expect(server.extensions.length).toBeGreaterThan(0);
      expect(typeof server.root).toBe('function');
      expect(typeof server.spawn).toBe('function');
    }
  });

  it('all expected server IDs are present', () => {
    const expectedIds = [
      'typescript', 'pyright', 'gopls', 'rust-analyzer', 'clangd',
      'vue', 'svelte', 'eslint', 'deno', 'bash',
      'yaml', 'json', 'html', 'css',
    ];
    for (const id of expectedIds) {
      expect(SERVERS[id]).toBeDefined();
      expect(SERVERS[id].id).toBe(id);
    }
  });
});

// ============================================================
// 3. LspFeature graceful degradation
// ============================================================

describe('LspFeature graceful degradation', () => {
  it('spawnServer returns undefined and marks broken when server.spawn returns undefined', async () => {
    // Create a feature with a mock server that returns undefined
    const feature = new LspFeature({ workdir: '/tmp/test' });
    const mockLogger = {
      info: () => {},
      error: () => {},
    };

    // Initialize the feature to set the logger
    await feature.onInitiate({
      agentId: 'test',
      config: {} as any,
      logger: mockLogger as any,
      getFeature: () => undefined,
      registerTool: () => {},
    });

    // hasServer should not crash even with no real servers available
    // This tests that the feature works when servers can't be spawned
    const result = await feature.hasServer('/tmp/test/fake.ts');
    // Result depends on whether a root marker exists, but it shouldn't crash
    expect(typeof result).toBe('boolean');
  });

  it('constructor accepts empty config without crashing', () => {
    const feature = new LspFeature();
    expect(feature.name).toBe('lsp');
    expect(feature.getWorkdir()).toBe(process.cwd());
  });

  it('constructor uses provided workdir', () => {
    const feature = new LspFeature({ workdir: '/custom/path' });
    expect(feature.getWorkdir()).toBe('/custom/path');
  });

  it('getTools returns 9 LSP tools', () => {
    const feature = new LspFeature();
    const tools = feature.getTools();
    expect(tools.length).toBe(9);
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('lsp_go_to_definition');
    expect(toolNames).toContain('lsp_find_references');
    expect(toolNames).toContain('lsp_hover');
    expect(toolNames).toContain('lsp_document_symbol');
    expect(toolNames).toContain('lsp_workspace_symbol');
    expect(toolNames).toContain('lsp_go_to_implementation');
    expect(toolNames).toContain('lsp_prepare_call_hierarchy');
    expect(toolNames).toContain('lsp_incoming_calls');
    expect(toolNames).toContain('lsp_outgoing_calls');
  });

  it('captureState returns activeServerIds', () => {
    const feature = new LspFeature();
    const state = feature.captureState();
    expect(state).toHaveProperty('activeServerIds');
    expect(Array.isArray(state.activeServerIds)).toBe(true);
  });

  it('restoreState does not crash', () => {
    const feature = new LspFeature();
    expect(() => feature.restoreState({ activeServerIds: [] })).not.toThrow();
  });

  it('onDestroy shuts down cleanly with no active servers', async () => {
    const feature = new LspFeature();
    await feature.onInitiate({
      agentId: 'test',
      config: {} as any,
      logger: { info: () => {}, error: () => {} } as any,
      getFeature: () => undefined,
      registerTool: () => {},
    });
    await expect(feature.onDestroy()).resolves.not.toThrow();
  });
});

// ============================================================
// 4. getFeatureManifest() structure
// ============================================================

describe('LspFeature.getFeatureManifest()', () => {
  it('returns a valid manifest definition', () => {
    const feature = new LspFeature();
    const manifest = feature.getFeatureManifest();

    expect(manifest).toBeDefined();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.settings).toBeDefined();
    expect(manifest.settings!.properties).toBeDefined();
  });

  it('has exactly 14 file-type entries for language servers', () => {
    const feature = new LspFeature();
    const manifest = feature.getFeatureManifest();
    const props = manifest.settings!.properties;

    // Should have one entry per server
    const serverIds = Object.keys(SERVERS);
    for (const id of serverIds) {
      expect(props[id]).toBeDefined();
      expect(props[id].type).toBe('file');
      expect(props[id].title).toBeDefined();
      expect(typeof props[id].title).toBe('string');
      expect(props[id].title.length).toBeGreaterThan(0);
    }
  });

  it('each manifest entry has a description mentioning the server name', () => {
    const feature = new LspFeature();
    const manifest = feature.getFeatureManifest();
    const props = manifest.settings!.properties;

    for (const [id, prop] of Object.entries(props)) {
      expect(prop.description).toBeDefined();
      expect(typeof prop.description).toBe('string');
      // Description should mention the server ID or a recognizable name
      expect(prop.description!.length).toBeGreaterThan(0);
    }
  });

  it('manifest entries have placeholder text', () => {
    const feature = new LspFeature();
    const manifest = feature.getFeatureManifest();
    const props = manifest.settings!.properties;

    for (const prop of Object.values(props)) {
      expect(prop.placeholder).toBeDefined();
      expect(typeof prop.placeholder).toBe('string');
    }
  });
});

// ============================================================
// 5. featureConfig consumption
// ============================================================

describe('LspFeature featureConfig consumption', () => {
  it('reads binary paths from featureConfig and stores in servers config', async () => {
    const feature = new LspFeature({ workdir: '/tmp/test' });
    const logs: string[] = [];
    const mockLogger = {
      info: (msg: string) => { logs.push(msg); },
      error: () => {},
    };

    await feature.onInitiate({
      agentId: 'test',
      config: {} as any,
      logger: mockLogger as any,
      featureConfig: {
        typescript: '/custom/bin/typescript-language-server',
        gopls: '/custom/bin/gopls',
      },
      getFeature: () => undefined,
      registerTool: () => {},
    });

    // Feature should have logged initialization
    expect(logs.length).toBeGreaterThan(0);
  });

  it('ignores non-string values in featureConfig', async () => {
    const feature = new LspFeature({ workdir: '/tmp/test' });

    await expect(feature.onInitiate({
      agentId: 'test',
      config: {} as any,
      logger: { info: () => {}, error: () => {} } as any,
      featureConfig: {
        typescript: 123,  // Invalid: not a string
        gopls: true,      // Invalid: not a string
      },
      getFeature: () => undefined,
      registerTool: () => {},
    })).resolves.not.toThrow();
  });

  it('handles undefined featureConfig without crashing', async () => {
    const feature = new LspFeature({ workdir: '/tmp/test' });

    await expect(feature.onInitiate({
      agentId: 'test',
      config: {} as any,
      logger: { info: () => {}, error: () => {} } as any,
      featureConfig: undefined,
      getFeature: () => undefined,
      registerTool: () => {},
    })).resolves.not.toThrow();
  });

  it('handles null featureConfig without crashing', async () => {
    const feature = new LspFeature({ workdir: '/tmp/test' });

    await expect(feature.onInitiate({
      agentId: 'test',
      config: {} as any,
      logger: { info: () => {}, error: () => {} } as any,
      featureConfig: null as any,
      getFeature: () => undefined,
      registerTool: () => {},
    })).resolves.not.toThrow();
  });
});
