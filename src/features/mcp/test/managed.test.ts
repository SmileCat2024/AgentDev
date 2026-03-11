import { mountMCPToolsFromConfig, MCPConnectionManager } from '../../../mcp/index.js';
import { loadMCPConfigFromInput } from '../../../mcp/config.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { MCPClient } from '../../../mcp/client.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * 检查 crawl4ai SSE 服务是否可用
 */
async function isServiceAvailable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // 加载 WebSearchFeature 内部的 crawl4ai 配置（与实际使用同源）
  const configDir = join(fileURLToPath(import.meta.url), '../../websearch/mcp/crawl4ai.json');
  const config = loadMCPConfigFromInput(configDir);

  if (!config) {
    console.log('[SKIP] failed to load crawl4ai config from websearch feature');
    return;
  }

  const serverConfig = Object.values(config.servers)[0];
  if (!serverConfig || typeof serverConfig.url !== 'string') {
    console.log('[SKIP] invalid crawl4ai config');
    return;
  }

  // 检查服务是否可用
  const serviceAvailable = await isServiceAvailable(serverConfig.url);
  if (!serviceAvailable) {
    console.log(`[SKIP] crawl4ai service not available at ${serverConfig.url}`);
    console.log('       Start the service with: crawl4ai-mcp --port 11235');
    console.log('[DONE] MCP managed tool test skipped');
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
        rename: {
          md: 'websearch_markdown_fetch',
        },
        describe: {
          md: 'Fetch webpage content as markdown via crawl4ai.',
        },
      }),
    });

    const toolNames = result.tools.map(tool => tool.name).sort();
    assert(toolNames.includes('websearch_markdown_fetch'), 'renamed tool should exist');
    assert(!toolNames.some(name => name.endsWith('_ask') || name === 'ask'), 'disabled tool should not exist');

    const markdownTool = result.tools.find(tool => tool.name === 'websearch_markdown_fetch');
    assert(markdownTool, 'renamed markdown tool should be available');
    assert(
      markdownTool.description === 'Fetch webpage content as markdown via crawl4ai.',
      'description override should be applied'
    );

    const markdownResult = await markdownTool.execute({ url: 'https://example.com' });
    const markdownContent = typeof markdownResult?.content === 'string'
      ? markdownResult.content
      : JSON.stringify(markdownResult);

    assert(markdownContent.includes('Example Domain'), 'managed tool should return page content');

    console.log('[PASS] managed MCP tools support rename / disable / description override');
    console.log('[DONE] MCP managed tool test passed');
  } finally {
    for (const client of clients.values()) {
      await client.dispose();
    }
    await manager.dispose();
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
