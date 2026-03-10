/**
 * WebSearch Feature - 网页内容获取工具
 *
 * 提供网页抓取和内容提取功能
 *
 * @example
 * ```typescript
 * import { WebSearchFeature } from './features/index.js';
 * const agent = new Agent({ ... }).use(new WebSearchFeature());
 * ```
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AgentFeature, FeatureInitContext } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import { createWebFetchTool } from './tools.js';
import { MCPClient, createMCPToolsFromClient } from '../../mcp/client.js';
import { loadMCPConfigFromInput } from '../../mcp/config.js';
import { MCPConnectionManager } from '../../mcp/connection-manager.js';
import type { MCPServerConfig } from '../../mcp/types.js';

// ESM 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function formatCrawl4aiToolName(toolName: string): string {
  return `websearch_crawl4ai_${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * WebSearch Feature 实现
 */
export class WebSearchFeature implements AgentFeature {
  readonly name = 'websearch';
  readonly dependencies: string[] = [];

  private readonly manager = new MCPConnectionManager();
  private readonly crawl4aiClients = new Map<string, MCPClient>();

  /**
   * 获取工具列表
   */
  getTools(): Tool[] {
    return [createWebFetchTool()];
  }

  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    const crawl4aiConfig = loadMCPConfigFromInput('.agentdev/mcps/crawl4ai.json');
    if (!crawl4aiConfig) {
      return [];
    }

    const tools: Tool[] = [];
    for (const [serverId, serverConfig] of Object.entries(crawl4aiConfig.servers)) {
      try {
        const client = this.crawl4aiClients.get(serverId) ?? new MCPClient(
          serverId,
          serverConfig as MCPServerConfig,
          this.manager
        );
        this.crawl4aiClients.set(serverId, client);

        const discoveredTools = await createMCPToolsFromClient(client, {
          mapName: (tool) => formatCrawl4aiToolName(tool.name),
          render: { call: 'crawl4ai', result: 'crawl4ai' },
        });
        tools.push(...discoveredTools);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[WebSearchFeature] Failed to load crawl4ai tools from "${serverId}": ${errorMsg}`);
      }
    }

    return tools;
  }

  async onDestroy(): Promise<void> {
    for (const client of this.crawl4aiClients.values()) {
      await client.dispose();
    }
    this.crawl4aiClients.clear();
    await this.manager.dispose();
  }

  /**
   * 模板路径声明
   */
  getTemplatePaths(): Record<string, string> {
    return {
      'web-fetch': join(__dirname, 'templates', 'web-fetch.render.js'),
      'web_fetch': join(__dirname, 'templates', 'web-fetch.render.js'),
      'crawl4ai': join(__dirname, 'templates', 'crawl4ai.render.js'),
    };
  }
}
