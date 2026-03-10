/**
 * MCP Feature - MCP 服务器连接和工具注册
 *
 * 将 MCP 集成从 Agent 核心中解耦，实现可外挂功能
 *
 * @example
 * ```typescript
 * // 自动扫描 .agentdev/mcps/*.json
 * agent.use(new MCPFeature());
 *
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

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type {
  AgentFeature,
  FeatureInitContext,
  ContextInjector,
  ToolContextValue,
} from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import { MCPClient, createMCPToolsFromClient, discoverMCPTools } from '../../mcp/client.js';
import { loadAllMCPConfigs, loadMCPConfigFromInput } from '../../mcp/config.js';
import { MCPConnectionManager } from '../../mcp/connection-manager.js';
import type { MCPConfig, MCPServerConfig } from '../../mcp/types.js';

// ESM 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * MCP Feature 配置类型
 */
export type MCPFeatureInput = MCPConfig | string;

/**
 * MCP Feature 实现
 */
export class MCPFeature implements AgentFeature {
  readonly name = 'mcp';
  readonly dependencies: string[] = [];

  private readonly manager = new MCPConnectionManager();
  private clients = new Map<string, MCPClient>();
  private config?: MCPConfig;
  private mcpContext?: Record<string, unknown>;

  constructor(input?: MCPFeatureInput) {
    if (typeof input === 'string') {
      this.config = loadMCPConfigFromInput(input);
    } else if (input) {
      this.config = input;
    } else {
      this.config = loadAllMCPConfigs();
    }
  }

  /**
   * 获取同步工具（无）
   */
  getTools(): Tool[] {
    return [];
  }

  /**
   * 模板路径声明
   */
  getTemplatePaths(): Record<string, string> {
    return {
      'mcp-tool': join(__dirname, 'templates', 'mcp-tool.render.js'),
      'mcp-result': join(__dirname, 'templates', 'mcp-tool.render.js'),
    };
  }

  /**
   * 获取异步工具（需要连接 MCP 服务器）
   */
  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    if (!this.config) {
      return [];
    }

    const tools: Tool[] = [];

    for (const [serverId, serverConfig] of Object.entries(this.config.servers)) {
      try {
        const existingClient = this.clients.get(serverId);
        if (existingClient) {
          tools.push(...await createMCPToolsFromClient(existingClient));
          continue;
        }

        const result = await discoverMCPTools(
          serverId,
          serverConfig as MCPServerConfig,
          {},
          this.manager
        );
        this.clients.set(serverId, result.client);
        tools.push(...result.tools);
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
    for (const client of this.clients.values()) {
      await client.dispose();
    }
    this.clients.clear();
    await this.manager.dispose();
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
