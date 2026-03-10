import type { Tool } from '../core/types.js';
import { MCPConnectionManager } from './connection-manager.js';
import { MCPToolAdapter, type MCPToolAdapterConfig } from './mcp-adapter.js';
import type { MCPServerConfig } from './types.js';

export interface MCPDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface MCPToolCreationOptions {
  name?: string;
  render?: MCPToolAdapterConfig['render'];
  transformArgs?: (args: Record<string, unknown>, context?: any) => Record<string, unknown>;
}

export interface MCPToolDiscoveryOptions {
  filter?: (tool: MCPDiscoveredTool) => boolean;
  mapName?: (tool: MCPDiscoveredTool) => string;
  render?: MCPToolAdapterConfig['render'];
  transformArgs?: MCPToolCreationOptions['transformArgs'];
}

export interface MCPDiscoveredToolSet {
  client: MCPClient;
  tools: Tool[];
}

export function createDefaultMCPToolName(serverId: string, toolName: string): string {
  return `mcp_${serverId}_${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

export class MCPClient {
  private readonly manager: MCPConnectionManager;
  private connected = false;

  constructor(
    readonly serverId: string,
    private readonly config: MCPServerConfig,
    manager?: MCPConnectionManager
  ) {
    this.manager = manager ?? new MCPConnectionManager();
  }

  async connect(): Promise<void> {
    if (this.connected && this.manager.isConnected(this.serverId)) {
      return;
    }
    await this.manager.connectServer(this.serverId, this.config);
    this.connected = true;
  }

  async listTools(): Promise<MCPDiscoveredTool[]> {
    await this.connect();
    return await this.manager.listTools(this.serverId);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    await this.connect();
    return await this.manager.callTool(name, this.serverId, args);
  }

  getConnectionManager(): MCPConnectionManager {
    return this.manager;
  }

  async dispose(): Promise<void> {
    this.connected = false;
    await this.manager.disconnectServer(this.serverId);
  }
}

export function createMCPTool(
  client: MCPClient,
  tool: MCPDiscoveredTool,
  options: MCPToolCreationOptions = {}
): Tool {
  return new MCPToolAdapter(
    {
      name: options.name ?? createDefaultMCPToolName(client.serverId, tool.name),
      description: tool.description || `MCP tool: ${tool.name}`,
      inputSchema: tool.inputSchema,
      enabled: true,
      handler: async (args: Record<string, unknown>, context?: any) => {
        const finalArgs = options.transformArgs ? options.transformArgs(args, context) : args;
        return await client.callTool(tool.name, finalArgs);
      },
    },
    {
      serverName: client.serverId,
      render: options.render,
    }
  );
}

export async function createMCPToolsFromClient(
  client: MCPClient,
  options: MCPToolDiscoveryOptions = {}
): Promise<Tool[]> {
  const tools = await client.listTools();

  return tools
    .filter(tool => options.filter ? options.filter(tool) : true)
    .map(tool => createMCPTool(client, tool, {
      name: options.mapName?.(tool),
      render: options.render,
      transformArgs: options.transformArgs,
    }));
}

export async function discoverMCPTools(
  serverId: string,
  config: MCPServerConfig,
  options: MCPToolDiscoveryOptions = {},
  manager?: MCPConnectionManager
): Promise<MCPDiscoveredToolSet> {
  const client = new MCPClient(serverId, config, manager);
  const tools = await createMCPToolsFromClient(client, options);
  return { client, tools };
}
