import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename } from 'path';
import { cwd } from 'process';
import { isAbsolute, join, resolve } from 'path';
import type { MCPConfig, MCPServerConfig } from './types.js';

function readConfigFile(configPath: string): unknown {
  try {
    if (!existsSync(configPath)) {
      return undefined;
    }

    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[MCP] Failed to load config "${configPath}": ${errorMsg}`);
    return undefined;
  }
}

function isMCPServerConfig(value: unknown): value is MCPServerConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const config = value as Record<string, unknown>;
  if (config.transport === 'stdio') {
    return typeof config.command === 'string' && Array.isArray(config.args);
  }

  if (config.transport === 'http') {
    return typeof config.url === 'string';
  }

  if (config.transport === 'sse') {
    return typeof config.url === 'string';
  }

  return false;
}

function isMCPConfig(value: unknown): value is MCPConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const config = value as Record<string, unknown>;
  return (
    (!!config.servers && typeof config.servers === 'object') ||
    (!!config.mcpServers && typeof config.mcpServers === 'object')
  );
}

function normalizeToMCPConfig(
  value: unknown,
  fallbackServerId: string
): MCPConfig | undefined {
  if (isMCPConfig(value)) {
    const config = value as unknown as Record<string, unknown>;
    const servers = (config.servers ?? config.mcpServers) as Record<string, MCPServerConfig> | undefined;
    if (!servers) {
      return undefined;
    }

    return {
      servers,
    };
  }

  if (isMCPServerConfig(value)) {
    return {
      servers: {
        [fallbackServerId]: value,
      },
    };
  }

  return undefined;
}

export function getDefaultMCPConfigDir(rootDir: string = cwd()): string {
  return join(rootDir, '.agentdev', 'mcps');
}

export function loadMCPConfigFromInput(input: string, rootDir: string = cwd()): MCPConfig | undefined {
  let configPath: string;
  let fallbackServerId = 'default';

  if (isAbsolute(input)) {
    configPath = input;
  } else if (input.includes('/') || input.includes('\\')) {
    configPath = resolve(rootDir, input);
    fallbackServerId = basename(configPath, '.json');
  } else {
    configPath = join(getDefaultMCPConfigDir(rootDir), `${input}.json`);
    fallbackServerId = input;
  }

  if (!existsSync(configPath)) {
    console.warn(`[MCP] Config file does not exist: ${configPath}`);
    return undefined;
  }

  return normalizeToMCPConfig(readConfigFile(configPath), fallbackServerId);
}

export function loadAllMCPConfigs(rootDir: string = cwd()): MCPConfig | undefined {
  const configDir = getDefaultMCPConfigDir(rootDir);
  if (!existsSync(configDir)) {
    return undefined;
  }

  const merged: MCPConfig = { servers: {} };
  const entries = readdirSync(configDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const configPath = join(configDir, entry.name);
    const config = readConfigFile(configPath);
    if (!config) {
      continue;
    }

    if (isMCPConfig(config)) {
      const normalized = normalizeToMCPConfig(config, basename(entry.name, '.json'));
      if (normalized && Object.keys(normalized.servers).length > 0) {
        Object.assign(merged.servers, normalized.servers);
        continue;
      }
    }

    const serverId = basename(entry.name, '.json');
    if (isMCPServerConfig(config)) {
      merged.servers[serverId] = config;
      continue;
    }

    console.warn(`[MCP] Ignoring invalid config file: ${configPath}`);
  }

  return Object.keys(merged.servers).length > 0 ? merged : undefined;
}
