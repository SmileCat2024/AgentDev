import { mountMCPToolsFromConfig, MCPConnectionManager } from '../src/mcp/index.js';
import type { MCPClient } from '../src/mcp/client.js';
import type { MCPConfig } from '../src/mcp/types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const config: MCPConfig = {
    servers: {
      'crawl4ai-official': {
        transport: 'sse',
        url: 'http://localhost:11235/mcp/sse',
      },
    },
  };

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
