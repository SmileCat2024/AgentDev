import { spawn, type ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CompatibilityCallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  MCPServerConfig,
  MCPSstdioConfig,
  MCPHTTPConfig,
  MCPSSEConfig,
  MCPConnectionInfo,
} from './types.js';
import { MCPConnectionState } from './types.js';

/**
 * MCP 连接详情
 */
interface MCPConnection {
  name: string;
  config: MCPServerConfig;
  server?: Client | any;
  process?: ChildProcess;
  transport?: any;
  state: MCPConnectionState;
  connectedAt?: number;
  lastError?: string;
  reconnectAttempts: number;
  responseBuffer: string;
  nextRequestId: number;
  toolCount: number;
  allowReconnect: boolean;
  pendingRequests: Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>;
}

export class MCPConnectionManager {
  private connections = new Map<string, MCPConnection>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  /**
   * 连接到 MCP 服务器
   */
  async connectServer(
    name: string,
    config: MCPServerConfig
  ): Promise<Client | any> {
    // 如果已存在连接，先尝试复用
    const existing = this.connections.get(name);
    if (existing?.server && existing.state === MCPConnectionState.Connected) {
      return existing.server;
    }

    // 创建新连接
    const connection: MCPConnection = {
      name,
      config,
      state: MCPConnectionState.Connecting,
      reconnectAttempts: 0,
      responseBuffer: '',
      nextRequestId: 1,
      toolCount: 0,
      allowReconnect: true,
      pendingRequests: new Map(),
    };
    this.connections.set(name, connection);

    try {
      if (config.transport === 'stdio') {
        return await this.connectStdio(name, config as MCPSstdioConfig, connection);
      } else if (config.transport === 'sse') {
        return await this.connectSSE(name, config as MCPSSEConfig, connection);
      } else {
        return await this.connectHTTP(name, config as MCPHTTPConfig, connection);
      }
    } catch (error) {
      connection.state = MCPConnectionState.Error;
      connection.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * 连接到 stdio MCP 服务器
   */
  private async connectStdio(
    name: string,
    config: MCPSstdioConfig,
    connection: MCPConnection
  ): Promise<any> {
    const isWindows = process.platform === 'win32';
    const useShell = isWindows || config.command.includes(' ') || config.command.includes('npx');

    const childProc = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: useShell,
      windowsHide: true,
    });

    childProc.on('error', (error: Error) => {
      connection.state = MCPConnectionState.Error;
      connection.lastError = error.message;
      this.rejectAllPendingRequests(connection, error);
      this.log('error', `MCP server ${name} process error: ${error.message}`);
    });

    const stderr = (childProc as any).stderr;
    if (stderr) {
      stderr.on('data', (data: Buffer) => {
        this.log('debug', `[MCP] ${name} stderr: ${data.toString()}`);
      });
    }

    const stdout = childProc.stdout;
    if (stdout) {
      stdout.on('data', (data: Buffer) => {
        this.handleProcessOutput(connection, data.toString());
      });
    }

    childProc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.log('info', `MCP server ${name} exited: code=${code}, signal=${signal}`);
      connection.state = MCPConnectionState.Disconnected;
      this.rejectAllPendingRequests(connection, new Error(`MCP server ${name} exited`));
      if (connection.allowReconnect) {
        this.scheduleReconnect(name);
      }
    });

    const startupDelay = process.platform === 'win32' ? 2000 : 500;
    await new Promise(resolve => setTimeout(resolve, startupDelay));

    this.log('info', `[MCP] Using direct JSON-RPC communication for ${name}`);

    connection.process = childProc;
    connection.server = childProc as any;
    connection.state = MCPConnectionState.Connected;
    connection.connectedAt = Date.now();
    connection.lastError = undefined;
    connection.reconnectAttempts = 0;

    this.log('info', `Connected to MCP server ${name} (stdio)`);
    return childProc as any;
  }

  /**
   * 连接到 HTTP MCP 服务器
   */
  private async connectSSE(
    name: string,
    config: MCPSSEConfig,
    connection: MCPConnection
  ): Promise<Client> {
    const client = new Client({
      name: `agentdev-${name}`,
      version: '0.1.0',
    });
    const transport = config.headers
      ? new SSEClientTransport(new URL(config.url), {
          eventSourceInit: { headers: config.headers } as any,
          requestInit: { headers: config.headers },
        })
      : new SSEClientTransport(new URL(config.url));

    await client.connect(transport);

    client.onerror = (error) => {
      connection.state = MCPConnectionState.Error;
      connection.lastError = error.message;
      this.log('error', `MCP server ${name} client error: ${error.message}`);
    };
    transport.onerror = (error) => {
      connection.state = MCPConnectionState.Error;
      connection.lastError = error.message;
      this.log('error', `MCP server ${name} SSE transport error: ${error.message}`);
    };
    transport.onclose = () => {
      this.log(
        connection.allowReconnect ? 'warn' : 'info',
        `MCP server ${name} SSE transport closed`
      );
      connection.state = MCPConnectionState.Disconnected;
      this.rejectAllPendingRequests(connection, new Error(`MCP server ${name} disconnected`));
      if (connection.allowReconnect) {
        this.scheduleReconnect(name);
      }
    };

    connection.transport = transport;
    connection.server = client;
    connection.state = MCPConnectionState.Connected;
    connection.connectedAt = Date.now();
    connection.lastError = undefined;
    connection.reconnectAttempts = 0;

    this.log('info', `Connected to MCP server ${name} (sse)`);
    return client;
  }

  /**
   * 连接到 HTTP MCP 服务器
   */
  private async connectHTTP(
    name: string,
    config: MCPHTTPConfig,
    connection: MCPConnection
  ): Promise<Client> {
    const client = new Client({
      name: `agentdev-${name}`,
      version: '0.1.0',
    });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
      reconnectionOptions: {
        maxRetries: config.retryCount ?? 3,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 30000,
        reconnectionDelayGrowFactor: 1.5,
      },
    });

    await client.connect(transport);

    client.onerror = (error) => {
      connection.state = MCPConnectionState.Error;
      connection.lastError = error.message;
      this.log('error', `MCP server ${name} client error: ${error.message}`);
    };
    transport.onerror = (error) => {
      connection.state = MCPConnectionState.Error;
      connection.lastError = error.message;
      this.log('error', `MCP server ${name} HTTP transport error: ${error.message}`);
    };
    transport.onclose = () => {
      this.log(
        connection.allowReconnect ? 'warn' : 'info',
        `MCP server ${name} HTTP transport closed`
      );
      connection.state = MCPConnectionState.Disconnected;
      this.rejectAllPendingRequests(connection, new Error(`MCP server ${name} disconnected`));
      if (connection.allowReconnect) {
        this.scheduleReconnect(name);
      }
    };

    connection.transport = transport;
    connection.server = client;
    connection.state = MCPConnectionState.Connected;
    connection.connectedAt = Date.now();
    connection.lastError = undefined;
    connection.reconnectAttempts = 0;

    this.log('info', `Connected to MCP server ${name} (http)`);
    return client;
  }

  /**
   * 断开服务器连接
   */
  async disconnectServer(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    connection.allowReconnect = false;

    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }

    if (connection.transport?.close) {
      try {
        await connection.transport.close();
      } catch (error) {
        this.log('warn', `Error closing MCP transport ${name}: ${error}`);
      }
    }

    if (connection.process) {
      connection.process.kill();
    }

    this.rejectAllPendingRequests(connection, new Error(`MCP server ${name} disconnected`));
    this.connections.delete(name);
    this.log('info', `Disconnected MCP server ${name}`);
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.all(names.map(name => this.disconnectServer(name)));
  }

  /**
   * 列出服务器的所有工具
   */
  async listTools(name: string): Promise<Array<{
    name: string;
    description?: string;
    inputSchema?: any;
  }>> {
    const connection = this.connections.get(name);
    if (!connection || connection.state !== MCPConnectionState.Connected) {
      this.log('warn', `[MCP] Cannot list tools: ${name} not connected`);
      return [];
    }

    try {
      const isDirectProcess = connection.process && connection.server &&
        !(connection.server as any).request;

      if (isDirectProcess) {
        this.log('info', `[MCP] Using direct process communication for ${name}`);
        const response = await this.sendDirectRequest(connection, 'tools/list', {}, 10000);
        const tools = response.result?.tools || [];
        connection.toolCount = tools.length;
        this.log('info', `[MCP] Received ${tools.length} tools`);
        return tools;
      }

      const response = await (connection.server as Client).request(
        {
          method: 'tools/list',
          params: {},
        },
        ListToolsResultSchema,
        { timeout: 5000 }
      );
      const tools = response.tools || [];
      connection.toolCount = tools.length;
      return tools;
    } catch (error) {
      this.log('error', `[MCP] Failed to list tools from ${name}: ${error}`);
      return [];
    }
  }

  async callTool(
     name: string,
     serverName: string,
     args: Record<string, unknown>
  ): Promise<{
    content: any[];
    isError?: boolean;
  }> {
    this.log('info', `[MCP] callTool: ${serverName}:${name}`);
    this.log('debug', `[MCP] args: ${JSON.stringify(args)}`);

    const connection = this.connections.get(serverName);
    if (!connection || connection.state !== MCPConnectionState.Connected) {
      throw new Error(`MCP server ${serverName} not connected`);
    }

    try {
      const isDirectProcess = connection.process && connection.server &&
        !(connection.server as any).request;

      if (isDirectProcess) {
        this.log('info', `[MCP] Using direct process communication for tool call`);
        const response = await this.sendDirectRequest(connection, 'tools/call', {
          name,
          arguments: args,
        }, 30000);
        const result = this.normalizeToolCallResponse(response);
        this.log('info', `[MCP] Tool ${name} returned: ${result.isError ? 'ERROR' : 'OK'}`);
        return result;
      }

      const response = await (connection.server as Client).request(
        {
          method: 'tools/call',
          params: {
            name,
            arguments: args,
          },
        },
        CompatibilityCallToolResultSchema,
        { timeout: 30000 }
      );
      return this.normalizeToolCallResponse(response);
    } catch (error) {
      this.log('error', `[MCP] Failed to call tool ${name}: ${error}`);
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }

  getConnectionInfo(name: string): MCPConnectionInfo | undefined {
    const connection = this.connections.get(name);
    if (!connection) return undefined;

    return {
      name: connection.name,
      state: connection.state,
      connectedAt: connection.connectedAt,
      lastError: connection.lastError,
      toolCount: connection.toolCount,
    };
  }

  /**
   * 获取所有连接信息
   */
  getAllConnections(): MCPConnectionInfo[] {
    return Array.from(this.connections.keys())
      .map(name => this.getConnectionInfo(name))
      .filter((info): info is MCPConnectionInfo => info !== undefined);
  }

  /**
   * 检查连接状态
   */
  isConnected(name: string): boolean {
    const connection = this.connections.get(name);
    return connection?.state === MCPConnectionState.Connected;
  }

  /**
   * 获取服务器实例
   */
  getServer(name: string): Client | any | undefined {
    return this.connections.get(name)?.server;
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(name: string): void {
    const existingTimer = this.reconnectTimers.get(name);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      const connection = this.connections.get(name);
      if (!connection) return;

      if (connection.reconnectAttempts >= 3) {
        this.log('error', `Max reconnect attempts reached for MCP server ${name}`);
        return;
      }

      connection.reconnectAttempts++;
      this.log('info', `Reconnecting to MCP server ${name} (attempt ${connection.reconnectAttempts})`);

      try {
        await this.connectServer(name, connection.config);
      } catch (error) {
        this.log('error', `Failed to reconnect to MCP server ${name}: ${error}`);
      }
    }, 5000);

    this.reconnectTimers.set(name, timer);
  }

  /**
   * 日志输出
   */
  private log(level: 'error' | 'warn' | 'info' | 'debug', message: string): void {
    const timestamp = new Date().toISOString();
    console[level](`[MCPConnectionManager ${timestamp}] ${message}`);
  }

  private handleProcessOutput(connection: MCPConnection, chunk: string): void {
    connection.responseBuffer += chunk;
    const lines = connection.responseBuffer.split(/\r?\n/);
    connection.responseBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const response = JSON.parse(trimmed);
        this.handleDirectResponse(connection, response);
      } catch {
        connection.responseBuffer = `${trimmed}\n${connection.responseBuffer}`;
        return;
      }
    }
  }

  private handleDirectResponse(connection: MCPConnection, response: any): void {
    if (typeof response?.id !== 'number') {
      this.log('debug', `[MCP] Ignoring non-response message from ${connection.name}: ${JSON.stringify(response)}`);
      return;
    }

    const pending = connection.pendingRequests.get(response.id);
    if (!pending) {
      this.log('debug', `[MCP] No pending request for response id ${response.id} from ${connection.name}`);
      return;
    }

    clearTimeout(pending.timeout);
    connection.pendingRequests.delete(response.id);
    pending.resolve(response);
  }

  private async sendDirectRequest(
    connection: MCPConnection,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<any> {
    if (!connection.process?.stdin) {
      throw new Error(`MCP server ${connection.name} has no stdin`);
    }

    const requestId = connection.nextRequestId++;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    };

    this.log('debug', `[MCP] Sending direct request: ${JSON.stringify(request)}`);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.pendingRequests.delete(requestId);
        reject(new Error(`Timeout waiting for ${method} from ${connection.name}`));
      }, timeoutMs);

      connection.pendingRequests.set(requestId, { resolve, reject, timeout });

      try {
        connection.process!.stdin!.write(JSON.stringify(request) + '\n');
      } catch (error) {
        clearTimeout(timeout);
        connection.pendingRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private normalizeToolCallResponse(response: any): { content: any[]; isError?: boolean } {
    if (response.error) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${response.error.message || 'Unknown error'}`,
        }],
        isError: true,
      };
    }

    if (response.result) {
      return response.result;
    }

    if (response.content || response.structuredContent || response.toolResult) {
      return response;
    }

    return { content: [] };
  }

  private rejectAllPendingRequests(connection: MCPConnection, error: Error): void {
    for (const [requestId, pending] of connection.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      connection.pendingRequests.delete(requestId);
    }
  }

  async dispose(): Promise<void> {
    await this.disconnectAll();

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
  }
}
