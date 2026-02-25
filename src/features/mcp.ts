/**
 * MCP Feature - MCP 服务器连接和工具注册
 *
 * 将 MCP 集成从 Agent 核心中解耦，实现可外挂功能
 *
 * @example
 * ```typescript
 * // 从配置文件加载（默认路径 .agentdev/mcps）
 * agent.use(new MCPFeature('github'));
 *
 * // 从指定路径加载配置
 * agent.use(new MCPFeature('./path/to/mcps/github'));
 *
 * // 直接传入配置对象
 * agent.use(new MCPFeature({ servers: { ... } }));
 * ```
 */

import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  ContextInjector,
  ToolContextValue,
} from '../core/feature.js';
import type { Tool } from '../core/types.js';
import type { ToolCall } from '../core/types.js';
import { MCPConnectionManager } from '../mcp/connection-manager.js';
import { MCPToolAdapter } from '../mcp/mcp-adapter.js';
import type { MCPConfig, MCPServerConfig } from '../mcp/types.js';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { cwd } from 'process';

/**
 * MCP Feature 配置类型
 */
export type MCPFeatureInput = MCPConfig | string;

/**
 * 加载 MCP 配置文件
 */
function loadMCPConfig(input: string): MCPConfig | undefined {
  try {
    let configPath: string;

    if (isAbsolute(input)) {
      configPath = input;
    } else if (input.includes('/') || input.includes('\\')) {
      // 相对路径
      configPath = resolve(cwd(), input);
    } else {
      // 服务器名称，使用默认路径
      configPath = join(cwd(), '.agentdev', 'mcps', `${input}.json`);
    }

    if (!existsSync(configPath)) {
      console.warn(`[MCPFeature] 配置文件不存在: ${configPath}`);
      return undefined;
    }

    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`[MCPFeature] 加载配置失败 "${input}": ${errorMsg}`);
    return undefined;
  }
}

/**
 * MCP Feature 实现
 */
export class MCPFeature implements AgentFeature {
  readonly name = 'mcp';
  readonly dependencies: string[] = [];

  private manager?: MCPConnectionManager;
  private config?: MCPConfig;
  private mcpContext?: Record<string, unknown>;
  private configInput?: MCPFeatureInput;

  constructor(input?: MCPFeatureInput) {
    this.configInput = input;

    if (typeof input === 'string') {
      this.config = loadMCPConfig(input);
    } else if (input) {
      this.config = input;
    }
  }

  /**
   * 获取异步工具（需要连接 MCP 服务器）
   */
  async getAsyncTools(ctx: FeatureInitContext): Promise<Tool[]> {
    if (!this.config) {
      return [];
    }

    this.manager = new MCPConnectionManager();
    const tools: Tool[] = [];

    for (const [serverId, serverConfig] of Object.entries(this.config.servers)) {
      try {
        await this.manager.connectServer(serverId, serverConfig as MCPServerConfig);
        const serverTools = await this.manager.listTools(serverId);

        for (const tool of serverTools) {
          if (!tool.name) continue;

          const toolName = `mcp_${serverId}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
          const originalToolName = tool.name;

          tools.push(new MCPToolAdapter(
            {
              name: toolName,
              description: tool.description || `MCP tool: ${originalToolName}`,
              inputSchema: tool.inputSchema,
              enabled: true,
              handler: async (args: any) => {
                return await this.manager!.callTool(
                  originalToolName,
                  serverId,
                  args
                );
              },
            },
            { serverName: serverId }
          ));
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[MCPFeature] Failed to load tools from "${serverId}": ${errorMsg}`);
      }
    }

    return tools;
  }

  /**
   * 声明上下文注入器
   * 为所有 MCP 工具注入 _mcpContext
   */
  getContextInjectors(): Map<string | RegExp, ContextInjector> {
    return new Map<string | RegExp, ContextInjector>([
      [/^mcp_/, (): ToolContextValue => ({ _mcpContext: this.mcpContext })],
    ]);
  }

  /**
   * 清理钩子
   */
  async onDestroy(): Promise<void> {
    if (this.manager) {
      await this.manager.dispose();
    }
  }

  /**
   * 设置 MCP 上下文（运行时注入）
   */
  setMCPContext(context: Record<string, unknown>): void {
    this.mcpContext = context;
  }

  /**
   * 获取连接管理器（供外部使用）
   */
  getConnectionManager(): MCPConnectionManager | undefined {
    return this.manager;
  }
}
