import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename } from 'path';
import { cwd } from 'process';
import { isAbsolute, join, resolve } from 'path';
import type { MCPConfig, MCPServerConfig } from './types.js';

export interface LoadAllMCPConfigsOptions {
  loadDefaultDir?: boolean;
  extraConfigFiles?: string[];
  excludeServers?: string[];
}

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

function resolveMCPConfigInput(
  input: string,
  rootDir: string = cwd()
): { configPath: string; fallbackServerId: string } {
  let configPath: string;
  let fallbackServerId = 'default';

  if (isAbsolute(input)) {
    configPath = input;
    fallbackServerId = basename(configPath, '.json');
  } else if (input.includes('/') || input.includes('\\')) {
    configPath = resolve(rootDir, input);
    fallbackServerId = basename(configPath, '.json');
  } else {
    configPath = join(getDefaultMCPConfigDir(rootDir), `${input}.json`);
    fallbackServerId = input;
  }

  return { configPath, fallbackServerId };
}

function loadMCPConfigFile(configPath: string, fallbackServerId: string): MCPConfig | undefined {
  const config = readConfigFile(configPath);
  if (!config) {
    return undefined;
  }

  const normalized = normalizeToMCPConfig(config, fallbackServerId);
  if (!normalized || Object.keys(normalized.servers).length === 0) {
    console.warn(`[MCP] Ignoring invalid config file: ${configPath}`);
    return undefined;
  }

  return normalized;
}

function getDedupedServerId(serverId: string, existingServerIds: Set<string>): string {
  if (!existingServerIds.has(serverId)) {
    return serverId;
  }

  let suffix = 1;
  let nextServerId = `${serverId} (${suffix})`;
  while (existingServerIds.has(nextServerId)) {
    suffix += 1;
    nextServerId = `${serverId} (${suffix})`;
  }

  return nextServerId;
}

function mergeMCPConfig(
  merged: MCPConfig,
  config: MCPConfig,
  excludedServers: Set<string>
): void {
  const existingServerIds = new Set(Object.keys(merged.servers));

  for (const [serverId, serverConfig] of Object.entries(config.servers)) {
    if (excludedServers.has(serverId)) {
      continue;
    }

    const dedupedServerId = getDedupedServerId(serverId, existingServerIds);
    merged.servers[dedupedServerId] = serverConfig;
    existingServerIds.add(dedupedServerId);
  }
}

export function getDefaultMCPConfigDir(rootDir: string = cwd()): string {
  return join(rootDir, '.agentdev', 'mcps');
}

export function loadMCPConfigFromInput(input: string, rootDir: string = cwd()): MCPConfig | undefined {
  const { configPath, fallbackServerId } = resolveMCPConfigInput(input, rootDir);

  if (!existsSync(configPath)) {
    console.warn(`[MCP] Config file does not exist: ${configPath}`);
    return undefined;
  }

  return loadMCPConfigFile(configPath, fallbackServerId);
}

export function loadAllMCPConfigs(
  rootDir: string = cwd(),
  options: LoadAllMCPConfigsOptions = {}
): MCPConfig | undefined {
  const shouldLoadDefaultDir = options.loadDefaultDir ?? true;
  const extraConfigFiles = Array.isArray(options.extraConfigFiles)
    ? options.extraConfigFiles.filter(Boolean)
    : [];
  const excludedServers = new Set(options.excludeServers ?? []);
  const merged: MCPConfig = { servers: {} };
  if (shouldLoadDefaultDir) {
    const configDir = getDefaultMCPConfigDir(rootDir);
    if (existsSync(configDir)) {
      const entries = readdirSync(configDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }

        const configPath = join(configDir, entry.name);
        const config = loadMCPConfigFile(configPath, basename(entry.name, '.json'));
        if (!config) {
          continue;
        }

        mergeMCPConfig(merged, config, excludedServers);
      }
    }
  }

  for (const configFile of extraConfigFiles) {
    const config = loadMCPConfigFromInput(configFile, rootDir);
    if (!config) {
      continue;
    }

    mergeMCPConfig(merged, config, excludedServers);
  }

  return Object.keys(merged.servers).length > 0 ? merged : undefined;
}
