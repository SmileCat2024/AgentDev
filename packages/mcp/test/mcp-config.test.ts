import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  getDefaultMCPConfigDir,
  loadMCPConfigFromInput,
  loadAllMCPConfigs,
} from '../../mcp/config.js';
import type { MCPConfig } from '../../mcp/types.js';

// ============================================================
// Helpers
// ============================================================

function makeTempDir(): string {
  return join(
    tmpdir(),
    `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function writeJSON(dir: string, name: string, data: unknown): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

// ============================================================
// getDefaultMCPConfigDir
// ============================================================

describe('getDefaultMCPConfigDir', () => {
  it('should return .agentdev/mcps under rootDir', () => {
    const dir = getDefaultMCPConfigDir('/project');
    expect(dir).toBe(join('/project', '.agentdev', 'mcps'));
  });

  it('should default to process.cwd() when rootDir is omitted', () => {
    const dir = getDefaultMCPConfigDir();
    expect(dir).toBe(join(process.cwd(), '.agentdev', 'mcps'));
  });
});

// ============================================================
// loadMCPConfigFromInput
// ============================================================

describe('loadMCPConfigFromInput', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should parse stdio server config from { servers } format', () => {
    writeJSON(tempDir, 'stdio.json', {
      servers: {
        myserver: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      },
    });

    const config = loadMCPConfigFromInput(
      join(tempDir, 'stdio.json'),
      tempDir
    );
    expect(config).toBeDefined();
    expect(config!.servers.myserver.transport).toBe('stdio');
  });

  it('should parse http server config', () => {
    writeJSON(tempDir, 'http.json', {
      servers: {
        webserver: {
          transport: 'http',
          url: 'http://localhost:3000',
        },
      },
    });

    const config = loadMCPConfigFromInput(
      join(tempDir, 'http.json'),
      tempDir
    );
    expect(config).toBeDefined();
    expect(config!.servers.webserver.transport).toBe('http');
  });

  it('should parse sse server config', () => {
    writeJSON(tempDir, 'sse.json', {
      servers: {
        sseserver: {
          transport: 'sse',
          url: 'http://localhost:4000/events',
        },
      },
    });

    const config = loadMCPConfigFromInput(
      join(tempDir, 'sse.json'),
      tempDir
    );
    expect(config).toBeDefined();
    expect(config!.servers.sseserver.transport).toBe('sse');
  });

  it('should map `type` field to `transport` (Claude Desktop format)', () => {
    writeJSON(tempDir, 'claude-desktop.json', {
      servers: {
        cdsrv: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'some-server'],
        },
      },
    });

    const config = loadMCPConfigFromInput(
      join(tempDir, 'claude-desktop.json'),
      tempDir
    );
    expect(config).toBeDefined();
    expect(config!.servers.cdsrv.transport).toBe('stdio');
  });

  it('should accept mcpServers key as alias for servers', () => {
    writeJSON(tempDir, 'mcpServers.json', {
      mcpServers: {
        alias: {
          transport: 'stdio',
          command: 'node',
          args: ['index.js'],
        },
      },
    });

    const config = loadMCPConfigFromInput(
      join(tempDir, 'mcpServers.json'),
      tempDir
    );
    expect(config).toBeDefined();
    expect(config!.servers.alias).toBeDefined();
    expect(config!.servers.alias.transport).toBe('stdio');
  });

  it('should accept single-server config format (no servers wrapper)', () => {
    writeJSON(tempDir, 'single.json', {
      transport: 'stdio',
      command: 'node',
      args: ['single.js'],
    });

    const config = loadMCPConfigFromInput(
      join(tempDir, 'single.json'),
      tempDir
    );
    expect(config).toBeDefined();
    expect(config!.servers.single.transport).toBe('stdio');
  });

  it('should return undefined for non-existent file', () => {
    const config = loadMCPConfigFromInput(
      join(tempDir, 'missing.json'),
      tempDir
    );
    expect(config).toBeUndefined();
  });

  it('should normalize but not reject configs with incomplete server definitions', () => {
    // The { servers: {...} } format normalizes servers without validating
    // individual server completeness. Invalid servers are still included.
    writeJSON(tempDir, 'invalid.json', {
      servers: {
        bad: { transport: 'stdio' }, // missing command and args
      },
    });

    const config = loadMCPConfigFromInput(
      join(tempDir, 'invalid.json'),
      tempDir
    );
    // Config is returned with the (incomplete) server still present
    expect(config).toBeDefined();
    expect(config!.servers.bad.transport).toBe('stdio');
    expect((config!.servers.bad as any).command).toBeUndefined();
  });

  it('should return undefined when single-server format is invalid', () => {
    // Single-server format (no { servers } wrapper) is validated strictly
    writeJSON(tempDir, 'single-invalid.json', {
      transport: 'stdio',
      // missing command and args
    });

    const config = loadMCPConfigFromInput(
      join(tempDir, 'single-invalid.json'),
      tempDir
    );
    expect(config).toBeUndefined();
  });

  it('should resolve short name to .agentdev/mcps/<name>.json', () => {
    const mcpsDir = join(tempDir, '.agentdev', 'mcps');
    mkdirSync(mcpsDir, { recursive: true });
    writeJSON(mcpsDir, 'short.json', {
      servers: {
        srv: { transport: 'http', url: 'http://localhost' },
      },
    });

    const config = loadMCPConfigFromInput('short', tempDir);
    expect(config).toBeDefined();
    expect(config!.servers.srv).toBeDefined();
  });

  it('should resolve relative path with directory separator', () => {
    const subDir = join(tempDir, 'configs');
    mkdirSync(subDir, { recursive: true });
    writeJSON(subDir, 'rel.json', {
      servers: {
        relsrv: { transport: 'http', url: 'http://localhost:9999' },
      },
    });

    const config = loadMCPConfigFromInput('configs/rel.json', tempDir);
    expect(config).toBeDefined();
    expect(config!.servers.relsrv).toBeDefined();
  });
});

// ============================================================
// loadAllMCPConfigs
// ============================================================

describe('loadAllMCPConfigs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load all .json files from default mcps directory', () => {
    const mcpsDir = join(tempDir, '.agentdev', 'mcps');
    mkdirSync(mcpsDir, { recursive: true });

    writeJSON(mcpsDir, 'a.json', {
      servers: {
        srvA: { transport: 'stdio', command: 'node', args: ['a.js'] },
      },
    });
    writeJSON(mcpsDir, 'b.json', {
      servers: {
        srvB: { transport: 'http', url: 'http://b:3000' },
      },
    });

    const config = loadAllMCPConfigs(tempDir);
    expect(config).toBeDefined();
    expect(Object.keys(config!.servers).sort()).toEqual(['srvA', 'srvB']);
  });

  it('should merge extra config files', () => {
    const mcpsDir = join(tempDir, '.agentdev', 'mcps');
    mkdirSync(mcpsDir, { recursive: true });

    writeJSON(mcpsDir, 'default.json', {
      servers: {
        base: { transport: 'stdio', command: 'node', args: ['base.js'] },
      },
    });

    writeJSON(tempDir, 'extra.json', {
      servers: {
        extra: { transport: 'http', url: 'http://extra:8080' },
      },
    });

    const config = loadAllMCPConfigs(tempDir, {
      extraConfigFiles: [join(tempDir, 'extra.json')],
    });
    expect(config).toBeDefined();
    expect(Object.keys(config!.servers).sort()).toEqual(['base', 'extra']);
  });

  it('should dedup server IDs when names collide', () => {
    const mcpsDir = join(tempDir, '.agentdev', 'mcps');
    mkdirSync(mcpsDir, { recursive: true });

    writeJSON(mcpsDir, 'a.json', {
      servers: {
        same: { transport: 'stdio', command: 'node', args: ['a.js'] },
      },
    });
    writeJSON(mcpsDir, 'b.json', {
      servers: {
        same: { transport: 'stdio', command: 'node', args: ['b.js'] },
      },
    });

    const config = loadAllMCPConfigs(tempDir);
    expect(config).toBeDefined();
    // Second "same" should be renamed to "same (1)"
    expect(config!.servers['same']).toBeDefined();
    expect(config!.servers['same (1)']).toBeDefined();
  });

  it('should exclude servers listed in excludeServers', () => {
    const mcpsDir = join(tempDir, '.agentdev', 'mcps');
    mkdirSync(mcpsDir, { recursive: true });

    writeJSON(mcpsDir, 'a.json', {
      servers: {
        keep: { transport: 'stdio', command: 'node', args: ['keep.js'] },
        drop: { transport: 'stdio', command: 'node', args: ['drop.js'] },
      },
    });

    const config = loadAllMCPConfigs(tempDir, {
      excludeServers: ['drop'],
    });
    expect(config).toBeDefined();
    expect(config!.servers.keep).toBeDefined();
    expect(config!.servers.drop).toBeUndefined();
  });

  it('should return undefined when default dir has no json files', () => {
    const mcpsDir = join(tempDir, '.agentdev', 'mcps');
    mkdirSync(mcpsDir, { recursive: true });

    // dir exists but empty
    const config = loadAllMCPConfigs(tempDir);
    expect(config).toBeUndefined();
  });

  it('should return undefined when default dir does not exist', () => {
    const config = loadAllMCPConfigs(tempDir);
    expect(config).toBeUndefined();
  });

  it('should skip non-json files in mcps dir', () => {
    const mcpsDir = join(tempDir, '.agentdev', 'mcps');
    mkdirSync(mcpsDir, { recursive: true });

    writeJSON(mcpsDir, 'valid.json', {
      servers: {
        ok: { transport: 'stdio', command: 'node', args: ['ok.js'] },
      },
    });
    writeFileSync(join(mcpsDir, 'readme.txt'), 'not a config');

    const config = loadAllMCPConfigs(tempDir);
    expect(config).toBeDefined();
    expect(Object.keys(config!.servers)).toEqual(['ok']);
  });

  it('should not load default dir when loadDefaultDir is false', () => {
    const mcpsDir = join(tempDir, '.agentdev', 'mcps');
    mkdirSync(mcpsDir, { recursive: true });

    writeJSON(mcpsDir, 'default.json', {
      servers: {
        fromDefault: { transport: 'stdio', command: 'node', args: ['x.js'] },
      },
    });

    writeJSON(tempDir, 'only.json', {
      servers: {
        fromExtra: { transport: 'stdio', command: 'node', args: ['y.js'] },
      },
    });

    const config = loadAllMCPConfigs(tempDir, {
      loadDefaultDir: false,
      extraConfigFiles: [join(tempDir, 'only.json')],
    });
    expect(config).toBeDefined();
    expect(config!.servers.fromExtra).toBeDefined();
    expect(config!.servers.fromDefault).toBeUndefined();
  });

  it('should merge servers from multiple extra config files', () => {
    writeJSON(tempDir, 'x.json', {
      servers: {
        srvX: { transport: 'http', url: 'http://x' },
      },
    });
    writeJSON(tempDir, 'y.json', {
      servers: {
        srvY: { transport: 'http', url: 'http://y' },
      },
    });

    const config = loadAllMCPConfigs(tempDir, {
      loadDefaultDir: false,
      extraConfigFiles: [
        join(tempDir, 'x.json'),
        join(tempDir, 'y.json'),
      ],
    });
    expect(config).toBeDefined();
    expect(Object.keys(config!.servers).sort()).toEqual(['srvX', 'srvY']);
  });

  it('should filter empty/falsy entries in extraConfigFiles', () => {
    writeJSON(tempDir, 'real.json', {
      servers: {
        real: { transport: 'http', url: 'http://real' },
      },
    });

    const config = loadAllMCPConfigs(tempDir, {
      loadDefaultDir: false,
      extraConfigFiles: [
        '',
        join(tempDir, 'real.json'),
        '' as any,
      ],
    });
    expect(config).toBeDefined();
    expect(config!.servers.real).toBeDefined();
  });
});
