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
import type { AgentFeature, FeatureInitContext, PackageInfo } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { createWebFetchTool } from './tools.js';
import type { MCPClient } from '../../mcp/client.js';
import { MCPConnectionManager } from '../../mcp/connection-manager.js';
import { loadMCPConfigFromInput } from '../../mcp/config.js';
import { mountMCPToolsFromConfig, type MCPToolManagementOptions } from '../../mcp/mount.js';
import type { MCPConfig, MCPSSEConfig } from '../../mcp/types.js';

// ESM 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_CRAWL4AI_CONFIG_PATH = join(__dirname, 'mcp', 'crawl4ai.json');

function formatCrawl4aiToolName(toolName: string): string {
  return `websearch_crawl4ai_${toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

export interface WebSearchFeatureConfig {
  crawl4ai?: false | (MCPToolManagementOptions & {
    server?: MCPSSEConfig;
  });
}

function createDefaultCrawl4aiConfig(config?: WebSearchFeatureConfig['crawl4ai']): MCPConfig {
  const baseConfig = loadMCPConfigFromInput(DEFAULT_CRAWL4AI_CONFIG_PATH);
  if (!baseConfig) {
    throw new Error(`Missing built-in crawl4ai config: ${DEFAULT_CRAWL4AI_CONFIG_PATH}`);
  }

  if (!(config && typeof config === 'object' && config.server)) {
    return baseConfig;
  }

  const [serverId] = Object.keys(baseConfig.servers);
  if (!serverId) {
    throw new Error(`Invalid built-in crawl4ai config: ${DEFAULT_CRAWL4AI_CONFIG_PATH}`);
  }

  return {
    servers: {
      ...baseConfig.servers,
      [serverId]: config.server,
    },
  };
}

/**
 * WebSearch Feature 实现
 */
export class WebSearchFeature implements AgentFeature {
  readonly name = 'websearch';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '提供网页抓取工具，并可托管 crawl4ai MCP 能力用于深度网页读取。';

  private readonly manager = new MCPConnectionManager();
  private readonly crawl4aiClients = new Map<string, MCPClient>();
  private _packageInfo: PackageInfo | null = null;

  constructor(private readonly config: WebSearchFeatureConfig = {}) {}

  /**
   * 获取工具列表
   */
  getTools(): Tool[] {
    return [createWebFetchTool()];
  }

  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    if (this.config.crawl4ai === false) {
      return [];
    }

    const crawl4aiConfig = createDefaultCrawl4aiConfig(this.config.crawl4ai);

    const result = await mountMCPToolsFromConfig(crawl4aiConfig, {
      manager: this.manager,
      clients: this.crawl4aiClients,
      getServerOptions: () => ({
        mapName: tool => formatCrawl4aiToolName(tool.name),
        render: { call: 'crawl4ai', result: 'crawl4ai' },
        describe: {
          md: 'Fetch a webpage and return cleaned Markdown content.',
          html: 'Fetch a webpage and return cleaned HTML content.',
          crawl: 'Crawl one or more URLs and return crawl results.',
          ask: 'Query crawl4ai knowledge and documentation context.',
        },
        ...(this.config.crawl4ai || {}),
      }),
      onError: (serverId, error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[WebSearchFeature] Failed to load crawl4ai tools from "${serverId}": ${errorMsg}`);
      },
    });

    return result.tools;
  }

  async onDestroy(): Promise<void> {
    for (const client of this.crawl4aiClients.values()) {
      await client.dispose();
    }
    this.crawl4aiClients.clear();
    await this.manager.dispose();
  }

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   */
  getTemplateNames(): string[] {
    // web-fetch 和 web_fetch 是别名，crawl4ai 是独立模板
    return ['web-fetch', 'web_fetch', 'crawl4ai'];
  }
}
