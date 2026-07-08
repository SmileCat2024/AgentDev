import { describe, it, expect } from 'vitest';
import { mountMCPToolsFromConfig, MCPConnectionManager } from '../../../mcp/index.js';
import { loadMCPConfigFromInput } from '../../../mcp/config.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { MCPClient } from '../../../mcp/client.js';

async function isServiceAvailable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    return true;
  } catch {
    return false;
  }
}

describe('Managed MCP tools', () => {
  it('should support rename / disable / description override', async () => {
    const configDir = join(fileURLToPath(import.meta.url), '../../websearch/mcp/crawl4ai.json');
    const config = loadMCPConfigFromInput(configDir);

    if (!config) {
      console.log('[SKIP] failed to load crawl4ai config from websearch feature');
      return;
    }

    const serverConfig = Object.values(config.servers)[0];
    if (!serverConfig || (serverConfig.transport !== 'sse' && serverConfig.transport !== 'http')) {
      console.log('[SKIP] invalid crawl4ai config (not SSE or HTTP transport)');
      return;
    }
    if (!('url' in serverConfig) || typeof serverConfig.url !== 'string') {
      console.log('[SKIP] invalid crawl4ai config (no url)');
      return;
    }

    const serviceUrl = (serverConfig as { url: string }).url;
    const serviceAvailable = await isServiceAvailable(serviceUrl);
    if (!serviceAvailable) {
      console.log(`[SKIP] crawl4ai service not available at ${serviceUrl}`);
      return;
    }

    const manager = new MCPConnectionManager();
    const clients = new Map<string, MCPClient>();

    try {
      const result = await mountMCPToolsFromConfig(config, {
        manager,
        clients,
        getServerOptions: () => ({
          disable: ['ask'],
          rename: { md: 'websearch_markdown_fetch' },
          describe: { md: 'Fetch webpage content as markdown via crawl4ai.' },
        }),
      });

      const toolNames = result.tools.map(tool => tool.name).sort();
      expect(toolNames.includes('websearch_markdown_fetch')).toBe(true);
      expect(!toolNames.some(name => name.endsWith('_ask') || name === 'ask')).toBe(true);

      const markdownTool = result.tools.find(tool => tool.name === 'websearch_markdown_fetch');
      expect(markdownTool).toBeDefined();
      expect(markdownTool!.description).toBe('Fetch webpage content as markdown via crawl4ai.');

      const markdownResult = await markdownTool!.execute({ url: 'https://example.com' });
      const markdownContent = typeof markdownResult?.content === 'string'
        ? markdownResult.content
        : JSON.stringify(markdownResult);

      expect(markdownContent).toContain('Example Domain');
    } finally {
      for (const client of clients.values()) {
        await client.dispose();
      }
      await manager.dispose();
    }
  });
});
