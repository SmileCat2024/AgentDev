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
import { loadAllMCPConfigs, loadMCPConfigFromInput } from '../../mcp/config.js';
import { MCPConnectionManager } from '../../mcp/connection-manager.js';
import { mountMCPToolsFromConfig } from '../../mcp/mount.js';
import type { MCPClient } from '../../mcp/client.js';
import type { MCPConfig } from '../../mcp/types.js';

// ESM 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * MCP Feature 配置类型
 */
export type MCPFeatureInput = MCPConfig | string;

export interface MCPFeatureOptions {
  excludeServers?: string[];
}

/**
 * MCP Feature 实现
 */
export class MCPFeature implements AgentFeature {
  readonly name = 'mcp';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '连接 MCP 服务器并把发现到的远程能力挂载成标准工具。';

  private readonly manager = new MCPConnectionManager();
  private clients = new Map<string, MCPClient>();
  private config?: MCPConfig;
  private mcpContext?: Record<string, unknown>;

  constructor(input?: MCPFeatureInput, options: MCPFeatureOptions = {}) {
    if (typeof input === 'string') {
      this.config = loadMCPConfigFromInput(input);
    } else if (input) {
      this.config = input;
    } else {
      this.config = loadAllMCPConfigs(undefined, {
        excludeServers: options.excludeServers,
      });
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

    const result = await mountMCPToolsFromConfig(this.config, {
      manager: this.manager,
      clients: this.clients,
      onError: (serverId, error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[MCPFeature] Failed to load tools from "${serverId}": ${errorMsg}`);
      },
    });

    return result.tools;
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
