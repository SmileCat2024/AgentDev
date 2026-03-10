import type { Tool } from '../core/types.js';
import { MCPConnectionManager } from './connection-manager.js';
import {
  MCPClient,
  createMCPTool,
  createDefaultMCPToolName,
  type MCPDiscoveredTool,
  type MCPToolCreationOptions,
} from './client.js';
import type { MCPToolAdapterConfig } from './mcp-adapter.js';
import type { MCPConfig, MCPServerConfig } from './types.js';

export interface MCPToolPatch {
  enabled?: boolean;
  name?: string;
  description?: string;
  render?: MCPToolAdapterConfig['render'];
  transformArgs?: MCPToolCreationOptions['transformArgs'];
}

export interface MCPToolManagementOptions {
  include?: string[];
  exclude?: string[];
  disable?: string[];
  rename?: Record<string, string>;
  describe?: Record<string, string>;
  render?: MCPToolAdapterConfig['render'];
  toolRender?: Record<string, MCPToolAdapterConfig['render']>;
  mapName?: (tool: MCPDiscoveredTool, client: MCPClient) => string;
  transformArgs?: MCPToolCreationOptions['transformArgs'];
  transform?: (tool: MCPDiscoveredTool, client: MCPClient) => MCPToolPatch | false | null | undefined;
}

export interface MCPConfigMountOptions {
  manager?: MCPConnectionManager;
  clients?: Map<string, MCPClient>;
  getServerOptions?: (
    serverId: string,
    serverConfig: MCPServerConfig
  ) => MCPToolManagementOptions | undefined;
  onError?: (serverId: string, error: unknown) => void;
}

export interface MCPMountedToolSet {
  client: MCPClient;
  tools: Tool[];
}

export interface MCPMountedConfigResult {
  tools: Tool[];
  clients: Map<string, MCPClient>;
}

function applyStaticPatch(
  tool: MCPDiscoveredTool,
  client: MCPClient,
  options: MCPToolManagementOptions
): MCPToolPatch {
  return {
    enabled: !options.disable?.includes(tool.name),
    name: options.rename?.[tool.name] ?? options.mapName?.(tool, client),
    description: options.describe?.[tool.name],
    render: options.toolRender?.[tool.name] ?? options.render,
    transformArgs: options.transformArgs,
  };
}

function shouldIncludeTool(tool: MCPDiscoveredTool, options: MCPToolManagementOptions): boolean {
  if (options.include && !options.include.includes(tool.name)) {
    return false;
  }
  if (options.exclude?.includes(tool.name)) {
    return false;
  }
  return true;
}

function mergeToolPatch(base: MCPToolPatch, override?: MCPToolPatch | false | null): MCPToolPatch | false {
  if (override === false) {
    return false;
  }
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    render: override.render ?? base.render,
    transformArgs: override.transformArgs ?? base.transformArgs,
  };
}

export async function createManagedMCPToolsFromClient(
  client: MCPClient,
  options: MCPToolManagementOptions = {}
): Promise<Tool[]> {
  const tools = await client.listTools();

  return tools.flatMap(tool => {
    if (!shouldIncludeTool(tool, options)) {
      return [];
    }

    const staticPatch = applyStaticPatch(tool, client, options);
    const finalPatch = mergeToolPatch(staticPatch, options.transform?.(tool, client));
    if (finalPatch === false || finalPatch.enabled === false) {
      return [];
    }

    return createMCPTool(
      client,
      {
        ...tool,
        description: finalPatch.description ?? tool.description,
      },
      {
        name: finalPatch.name ?? createDefaultMCPToolName(client.serverId, tool.name),
        description: finalPatch.description,
        render: finalPatch.render,
        transformArgs: finalPatch.transformArgs,
      }
    );
  });
}

export async function discoverManagedMCPTools(
  serverId: string,
  config: MCPServerConfig,
  options: MCPToolManagementOptions = {},
  manager?: MCPConnectionManager
): Promise<MCPMountedToolSet> {
  const client = new MCPClient(serverId, config, manager);
  const tools = await createManagedMCPToolsFromClient(client, options);
  return { client, tools };
}

export async function mountMCPToolsFromConfig(
  config: MCPConfig,
  options: MCPConfigMountOptions = {}
): Promise<MCPMountedConfigResult> {
  const clients = options.clients ?? new Map<string, MCPClient>();
  const tools: Tool[] = [];

  for (const [serverId, serverConfig] of Object.entries(config.servers)) {
    try {
      const client = clients.get(serverId) ?? new MCPClient(serverId, serverConfig, options.manager);
      clients.set(serverId, client);

      const serverOptions = options.getServerOptions?.(serverId, serverConfig) ?? {};
      tools.push(...await createManagedMCPToolsFromClient(client, serverOptions));
    } catch (error) {
      options.onError?.(serverId, error);
    }
  }

  return { tools, clients };
}
