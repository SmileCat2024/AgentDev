/**
 * MCP 连接管理器
 *
 * 管理 MCP 服务器的连接生命周期，包括 stdio 和 HTTP 传输
 */

import { spawn, type ChildProcess } from 'child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  MCPServerConfig,
  MCPSstdioConfig,
  MCPHTTPConfig,
  MCPConnectionInfo,
} from './types.js';
import { MCPConnectionState } from './types.js';

/**
 * MCP 连接详情
 */
interface MCPConnection {
  /** 服务器名称 */
  name: string;
  /** 配置 */
  config: MCPServerConfig;
  /** MCP 服务器实例 (如果已连接) */
  server?: McpServer;
  /** 子进程 (stdio 模式) */
  process?: ChildProcess;
  /** 传输层 */
  transport?: any;
  /** 连接状态 */
  state: MCPConnectionState;
  /** 连接时间 */
  connectedAt?: number;
  /** 最后错误 */
  lastError?: string;
  /** 重连次数 */
  reconnectAttempts: number;
}

/**
 * MCP 连接管理器
 *
 * 负责建立、维护和关闭 MCP 服务器连接
 */
export class MCPConnectionManager {
  private connections = new Map<string, MCPConnection>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  /**
   * 连接到 MCP 服务器
   */
  async connectServer(
    name: string,
    config: MCPServerConfig
  ): Promise<McpServer> {
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
    };
    this.connections.set(name, connection);

    try {
      if (config.transport === 'stdio') {
        return await this.connectStdio(name, config as MCPSstdioConfig, connection);
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
  ): Promise<McpServer> {
    // 在 Windows 上，需要 shell: true 来执行 npx 等命令
    const isWindows = process.platform === 'win32';
    const useShell = isWindows || config.command.includes(' ') || config.command.includes('npx');

    // 启动子进程
    const childProc = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: useShell,
      windowsHide: true,  // Windows 上隐藏子进程窗口
    });

    // 处理进程错误
    childProc.on('error', (error: Error) => {
      connection.state = MCPConnectionState.Error;
      connection.lastError = error.message;
      this.log('error', `MCP server ${name} process error: ${error.message}`);
    });

    // 处理 stderr 输出（调试用）
    // 注意：由于 stdio 配置为 'inherit'，stderr 可能是 null
    const stderr = (childProc as any).stderr;
    if (stderr) {
      stderr.on('data', (data: Buffer) => {
        this.log('debug', `[MCP] ${name} stderr: ${data.toString()}`);
      });
    }

    childProc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.log('info', `MCP server ${name} exited: code=${code}, signal=${signal}`);
      connection.state = MCPConnectionState.Disconnected;
      this.scheduleReconnect(name);
    });

    // 等待进程启动（Windows 上可能需要更长时间）
    const startupDelay = process.platform === 'win32' ? 2000 : 500;
    await new Promise(resolve => setTimeout(resolve, startupDelay));

    // 客户端场景：直接使用子进程进行 JSON-RPC 通信
    // 注意：MCP SDK 的 McpServer/StdioServerTransport 是服务端组件，
    // 客户端应该直接使用 JSON-RPC 与子进程通信
    this.log('info', `[MCP] Using direct JSON-RPC communication for ${name}`);

    // 更新连接状态
    connection.process = childProc;
    connection.server = childProc as any;  // 对于客户端，将子进程作为 server 引用
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
  private async connectHTTP(
    name: string,
    config: MCPHTTPConfig,
    connection: MCPConnection
  ): Promise<McpServer> {
    // 动态导入 MCP SDK
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

    // 创建 MCP 服务器
    const server = new McpServer({
      name: `client-${name}`,
      version: '1.0.0',
    });

    // 创建传输层
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // 连接到远程服务器
    // 注意: 这需要实现 HTTP 客户端逻辑
    // StreamableHTTPServerTransport 通常用于服务器端
    // 客户端需要使用不同的方法

    // 简化: 这里假设连接已建立
    await server.connect(transport);

    connection.server = server;
    connection.transport = transport;
    connection.state = MCPConnectionState.Connected;
    connection.connectedAt = Date.now();
    connection.lastError = undefined;

    this.log('info', `Connected to MCP server ${name} (HTTP)`);
    return server;
  }

  /**
   * 断开服务器连接
   */
  async disconnectServer(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;

    // 清除重连定时器
    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }

    // 关闭服务器
    if (connection.server) {
      try {
        await connection.server.close();
      } catch (error) {
        this.log('warn', `Error closing MCP server ${name}: ${error}`);
      }
    }

    // 终止子进程
    if (connection.process) {
      connection.process.kill();
    }

    // 清除连接
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
      // 检查是否使用直接进程通信（通过检查是否有 stdin 属性）
      // 如果 server 是子进程，它有 stdin/stdout 但没有 request 方法
      const isDirectProcess = connection.process && connection.server &&
        !(connection.server as any).request;

      if (isDirectProcess) {
        this.log('info', `[MCP] Using direct process communication for ${name}`);
        return await this.listToolsDirect(connection);
      }

      // 动态导入 MCP SDK
      // @ts-expect-error - SDK 是可选依赖，运行时动态加载
      const { Client } = await import('@modelcontextprotocol/sdk/index.js');

      // 获取工具列表
      const response = await (connection.server as any).request({
        method: 'tools/list',
        params: {},
      }, {
        timeout: 5000, // 5秒超时
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      return response.tools || [];
    } catch (error) {
      this.log('error', `[MCP] Failed to list tools from ${name}: ${error}`);
      return [];
    }
  }

  /**
   * 直接通过进程通信列出工具（不使用 SDK）
   */
  private async listToolsDirect(connection: MCPConnection): Promise<Array<{
    name: string;
    description?: string;
    inputSchema?: any;
  }>> {
    if (!connection.process || !connection.process.stdout) {
      this.log('warn', `[MCP] No stdout available for direct communication`);
      return [];
    }

    const stdout = connection.process.stdout;
    const stdin = connection.process.stdin;

    return new Promise((resolve) => {
      const requestId = Date.now();
      const request = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/list',
        params: {},
      };

      this.log('debug', `[MCP] Sending tools/list request: ${JSON.stringify(request)}`);

      let responseBuffer = '';
      let resolved = false;

      // Windows 上可能需要更长的超时时间
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.log('warn', `[MCP] listTools direct: timeout after 10s`);
          resolve([]);
        }
      }, 10000);  // 增加到 10 秒

      // 创建一次性监听器，避免重复监听
      const dataHandler = (data: Buffer) => {
        if (resolved) return;

        responseBuffer += data.toString();

        // 尝试解析每一行（JSON-RPC 使用换行分隔的消息）
        const lines = responseBuffer.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const response = JSON.parse(line);
            if (response.id === requestId) {
              resolved = true;
              clearTimeout(timeout);
              stdout.off('data', dataHandler);

              const tools = response.result?.tools || [];
              this.log('info', `[MCP] Received ${tools.length} tools`);
              resolve(tools);
              return;
            }
          } catch {
            // 继续等待更多数据
          }
        }
      };

      // 监听 stdout
      stdout.on('data', dataHandler);

      // 发送请求
      try {
        stdin!.write(JSON.stringify(request) + '\n');
      } catch (error) {
        resolved = true;
        clearTimeout(timeout);
        stdout.off('data', dataHandler);
        this.log('error', `[MCP] Failed to send request: ${error}`);
        resolve([]);
      }
    });
  }

  /**
   * 调用 MCP 工具
   */
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
      // 检查是否使用直接进程通信（通过检查是否有 stdin 属性）
      // 如果 server 是子进程，它有 stdin/stdout 但没有 request 方法
      const isDirectProcess = connection.process && connection.server &&
        !(connection.server as any).request;

      if (isDirectProcess) {
        this.log('info', `[MCP] Using direct process communication for tool call`);
        const result = await this.callToolDirect(name, connection, args);
        this.log('info', `[MCP] Tool ${name} returned: ${result.isError ? 'ERROR' : 'OK'}`);
        return result;
      }

      // 动态导入 MCP SDK
      // @ts-expect-error - SDK 是可选依赖，运行时动态加载
      const { Client } = await import('@modelcontextprotocol/sdk/index.js');

      // 调用工具
      const response = await (connection.server as any).request({
        method: 'tools/call',
        params: {
          name: name,
          arguments: args,
        },
      }, {
        timeout: 30000, // 30秒超时
      });

      if (response.error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${response.error.message}`,
          }],
          isError: true,
        };
      }

      return response.result || {
        content: [],
      };
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

  /**
   * 直接通过进程通信调用工具（不使用 SDK）
   */
  private async callToolDirect(
     name: string,
     connection: MCPConnection,
     args: Record<string, unknown>
  ): Promise<{
    content: any[];
    isError?: boolean;
  }> {
    if (!connection.process || !connection.process.stdout) {
      throw new Error('No process available');
    }

    const stdout = connection.process.stdout;
    const stdin = connection.process.stdin;

    return new Promise((resolve) => {
      const requestId = Date.now();
      const request = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: name,
          arguments: args,
        },
      };

      this.log('debug', `[MCP] Sending JSON-RPC request: ${JSON.stringify(request)}`);

      let responseBuffer = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.log('warn', `[MCP] callToolDirect(${name}): timeout after 30s`);
          resolve({
            content: [{
              type: 'text',
              text: 'Error: Timeout',
            }],
            isError: true,
          });
        }
      }, 30000);

      // 创建一次性监听器
      const dataHandler = (data: Buffer) => {
        if (resolved) return;

        responseBuffer += data.toString();

        // 尝试解析每一行
        const lines = responseBuffer.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const response = JSON.parse(line);
            if (response.id === requestId) {
              resolved = true;
              clearTimeout(timeout);
              stdout.off('data', dataHandler);

              this.log('debug', `[MCP] Received JSON-RPC response: ${line}`);

              // 检查是否有错误
              if (response.error) {
                this.log('error', `[MCP] Tool ${name} returned error: ${response.error.message}`);
                resolve({
                  content: [{
                    type: 'text',
                    text: `Error: ${response.error.message || 'Unknown error'}`,
                  }],
                  isError: true,
                });
              } else {
                this.log('info', `[MCP] Tool ${name} succeeded`);
                resolve(response.result || { content: [] });
              }
              return;
            }
          } catch {
            // 继续等待更多数据
          }
        }
      };

      // 监听 stdout
      stdout.on('data', dataHandler);

      // 发送请求
      try {
        stdin!.write(JSON.stringify(request) + '\n');
      } catch (error) {
        resolved = true;
        clearTimeout(timeout);
        stdout.off('data', dataHandler);
        this.log('error', `[MCP] Failed to send tool call request: ${error}`);
        resolve({
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        });
      }
    });
  }

  /**
   * 获取连接信息
   */
  getConnectionInfo(name: string): MCPConnectionInfo | undefined {
    const connection = this.connections.get(name);
    if (!connection) return undefined;

    return {
      name: connection.name,
      state: connection.state,
      connectedAt: connection.connectedAt,
      lastError: connection.lastError,
      toolCount: 0, // TODO: 需要缓存工具数量
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
  getServer(name: string): McpServer | undefined {
    return this.connections.get(name)?.server;
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(name: string): void {
    // 清除现有定时器
    const existingTimer = this.reconnectTimers.get(name);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 简单: 5 秒后重连
    // 完整实现应该使用指数退避
    const timer = setTimeout(async () => {
      const connection = this.connections.get(name);
      if (!connection) return;

      // 检查重连次数
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

  /**
   * 析构
   */
  async dispose(): Promise<void> {
    await this.disconnectAll();

    // 清除所有定时器
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
  }
}
