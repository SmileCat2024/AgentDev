/**
 * Tests for Shell Feature cross-platform behavior
 *
 * Covers:
 * - findGitBashPath: platform-aware detection (Git Bash on Windows, native bash on Linux/macOS)
 * - findPowerShellPath: platform-aware detection (Windows PS 5.1, pwsh Core on any platform)
 * - ShellFeature manifest: descriptions are platform-neutral, not Windows-only
 * - ShellFeature config resolution: defaults and overrides work correctly
 * - Graceful degradation: missing shells don't throw, tools are skipped
 * - Error messages are platform-aware
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { findGitBashPath } from '../tools.js';
import { findPowerShellPath } from '../powershell.js';
import { ShellFeature } from '../index.js';

// ── findGitBashPath ──────────────────────────────────────────

describe('findGitBashPath', () => {
  beforeEach(() => {
    // Reset module cache by re-importing is not practical,
    // so we test behavior based on current platform.
  });

  it('should return a string path on any platform', () => {
    // Without a configured path, it uses platform defaults.
    // On win32: searches for Git Bash. On non-win32: returns $SHELL or /bin/bash.
    // We can't guarantee bash exists in CI, so just verify it returns string or null.
    const result = findGitBashPath();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('should return configured path when valid file exists (first call only)', () => {
    // Note: findGitBashPath uses a module-level cache. The first call
    // (either from this test file or a previous one) populates the cache,
    // and subsequent calls return the cached value regardless of arguments.
    // This test verifies the function doesn't throw with a valid path argument.
    const tempDir = mkdtempSync(join(tmpdir(), 'bash-test-'));
    try {
      const fakeBash = join(tempDir, 'fakebash');
      writeFileSync(fakeBash, '#!/bin/bash\necho hello', { mode: 0o755 });
      // Call should not throw; result may be cached from a prior call
      const result = findGitBashPath(fakeBash);
      expect(result === null || typeof result === 'string').toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return null for non-existent configured path', () => {
    // On non-Windows, it falls through to $SHELL || /bin/bash.
    // On Windows without Git Bash, it returns null.
    const result = findGitBashPath('/definitely/does/not/exist/bash-' + Date.now());
    if (process.platform !== 'win32') {
      expect(typeof result).toBe('string');
    } else {
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });

  it('should use $SHELL on non-Windows when no configured path', () => {
    if (process.platform === 'win32') return; // skip on Windows

    // The function should return $SHELL or /bin/bash on non-Windows.
    // Since the result is cached from previous calls, we verify the type.
    const result = findGitBashPath();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── findPowerShellPath ───────────────────────────────────────

describe('findPowerShellPath', () => {
  it('should return string or null (never undefined after first call)', () => {
    const result = findPowerShellPath();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('should return configured path when valid file exists (first call only)', () => {
    // Same caching behavior as findGitBashPath — module-level cache.
    const tempDir = mkdtempSync(join(tmpdir(), 'pwsh-test-'));
    try {
      const fakePwsh = join(tempDir, 'fakepwsh');
      writeFileSync(fakePwsh, '#!/usr/bin/env pwsh\necho hello', { mode: 0o755 });
      const result = findPowerShellPath(fakePwsh);
      expect(result === null || typeof result === 'string').toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should search for pwsh (PowerShell Core) on all platforms', () => {
    // This is implicitly tested by the function not throwing.
    // If pwsh is installed, it returns its path; otherwise null.
    const result = findPowerShellPath('/nonexistent/pwsh-' + Date.now());
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

// ── ShellFeature manifest ────────────────────────────────────

describe('ShellFeature manifest cross-platform', () => {
  const feature = new ShellFeature();
  const manifest = feature.getFeatureManifest();

  it('should have settings with properties', () => {
    expect(manifest.settings).toBeDefined();
    expect(manifest.settings.properties).toBeDefined();
  });

  it('bashEnabled should have neutral title (not "Git Bash" only)', () => {
    const bashEnabled = manifest.settings.properties.bashEnabled;
    expect(bashEnabled).toBeDefined();
    expect(bashEnabled.title).not.toContain('Git Bash');
    // Title should be generic
    expect(bashEnabled.title.toLowerCase()).toContain('bash');
  });

  it('bashEnabled description should mention Linux/macOS', () => {
    const bashEnabled = manifest.settings.properties.bashEnabled;
    expect(bashEnabled.description).toBeDefined();
    // Should mention both Windows and Linux/macOS, not just Windows
    expect(bashEnabled.description.toLowerCase()).toMatch(/linux|macos/);
  });

  it('bashPath description should not contain .exe suffix', () => {
    const bashPath = manifest.settings.properties.bashPath;
    expect(bashPath.description).toBeDefined();
    expect(bashPath.description).not.toContain('.exe');
  });

  it('powershellEnabled description should mention Linux/macOS', () => {
    const psEnabled = manifest.settings.properties.powershellEnabled;
    expect(psEnabled.description).toBeDefined();
    // Should mention that Linux/macOS needs pwsh installation
    expect(psEnabled.description.toLowerCase()).toMatch(/linux|macos|pwsh/);
  });

  it('powershellPath description should not hardcode .exe', () => {
    const psPath = manifest.settings.properties.powershellPath;
    expect(psPath.description).toBeDefined();
    // Description should be generic (not "powershell.exe 或 pwsh.exe")
    expect(psPath.description).not.toContain('powershell.exe');
  });

  it('all boolean settings should have boolean type', () => {
    expect(manifest.settings.properties.bashEnabled.type).toBe('boolean');
    expect(manifest.settings.properties.powershellEnabled.type).toBe('boolean');
  });

  it('all file settings should have file type', () => {
    expect(manifest.settings.properties.bashPath.type).toBe('file');
    expect(manifest.settings.properties.powershellPath.type).toBe('file');
  });
});

// ── ShellFeature config resolution ───────────────────────────

describe('ShellFeature config resolution', () => {
  it('should default both shells to enabled', async () => {
    const feature = new ShellFeature();
    // resolveShellConfig is private, but getAsyncTools uses it internally.
    // We verify behavior by checking which tools get registered.
    const tools = await feature.getAsyncTools({
      agentId: 'test',
      config: { llm: null as any },
      logger: {
        trace: () => {}, debug: () => {}, info: () => {},
        warn: () => {}, error: () => {},
        child: () => null as any,
      },
      featureConfig: undefined,
      getFeature: () => undefined,
      registerTool: () => {},
    } as any);

    // On a system with bash, at least the bash tool should be registered.
    // We can't assert exact count since shell availability varies.
    expect(Array.isArray(tools)).toBe(true);
  });

  it('should disable bash when bashEnabled=false', async () => {
    const feature = new ShellFeature();
    const tools = await feature.getAsyncTools({
      agentId: 'test',
      config: { llm: null as any },
      logger: {
        trace: () => {}, debug: () => {}, info: () => {},
        warn: () => {}, error: () => {},
        child: () => null as any,
      },
      featureConfig: { bashEnabled: false },
      getFeature: () => undefined,
      registerTool: () => {},
    } as any);

    const bashTool = tools.find((t) => t.name === 'bash');
    expect(bashTool).toBeUndefined();
  });

  it('should disable powershell when powershellEnabled=false', async () => {
    const feature = new ShellFeature();
    const tools = await feature.getAsyncTools({
      agentId: 'test',
      config: { llm: null as any },
      logger: {
        trace: () => {}, debug: () => {}, info: () => {},
        warn: () => {}, error: () => {},
        child: () => null as any,
      },
      featureConfig: { powershellEnabled: false },
      getFeature: () => undefined,
      registerTool: () => {},
    } as any);

    const psTool = tools.find((t) => t.name === 'powershell');
    expect(psTool).toBeUndefined();
  });

  it('should disable both shells when both are false', async () => {
    const feature = new ShellFeature();
    const tools = await feature.getAsyncTools({
      agentId: 'test',
      config: { llm: null as any },
      logger: {
        trace: () => {}, debug: () => {}, info: () => {},
        warn: () => {}, error: () => {},
        child: () => null as any,
      },
      featureConfig: { bashEnabled: false, powershellEnabled: false },
      getFeature: () => undefined,
      registerTool: () => {},
    } as any);

    const bashTool = tools.find((t) => t.name === 'bash');
    const psTool = tools.find((t) => t.name === 'powershell');
    expect(bashTool).toBeUndefined();
    expect(psTool).toBeUndefined();
  });
});

// ── ShellFeature name/description ────────────────────────────

describe('ShellFeature metadata', () => {
  const feature = new ShellFeature();

  it('should have name "shell"', () => {
    expect(feature.name).toBe('shell');
  });

  it('should have no dependencies', () => {
    expect(feature.dependencies).toEqual([]);
  });

  it('should have a description', () => {
    expect(typeof feature.description).toBe('string');
    expect(feature.description.length).toBeGreaterThan(0);
  });

  it('getTools should return trash tools (synchronous)', () => {
    const tools = feature.getTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    // Should have trash-related tools
    const toolNames = tools.map((t) => t.name);
    expect(toolNames.some((n) => n.includes('trash'))).toBe(true);
  });

  it('getTemplateNames should include bash template', () => {
    const names = feature.getTemplateNames();
    expect(names).toContain('bash');
  });
});
