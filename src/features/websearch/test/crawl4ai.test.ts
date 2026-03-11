import { BasicAgent } from '../../../agents/index.js';
// 注意：测试时 ProgrammingHelperAgent 从 examples 目录导入，实际使用时从正确的位置导入
// 这里仅用于测试 Feature 挂载逻辑
import type { LLMClient, LLMResponse, Message, Tool } from '../../../core/types.js';
import { WebSearchFeature } from '../../index.js';
import { loadMCPConfigFromInput } from '../../../mcp/config.js';
import { join } from 'path';
import { fileURLToPath } from 'url';

class MockLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'ok' };
  }
}

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
  const configDir = join(fileURLToPath(import.meta.url), '../mcp/crawl4ai.json');
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
  // 类型守卫：确认是 SSE 或 HTTP 配置后才有 url 属性
  if (!('url' in serverConfig) || typeof serverConfig.url !== 'string') {
    console.log('[SKIP] invalid crawl4ai config (no url)');
    return;
  }

  // 检查服务是否可用（类型守卫后 url 属性已确认存在）
  const serviceUrl = (serverConfig as { url: string }).url;
  const serviceAvailable = await isServiceAvailable(serviceUrl);
  if (!serviceAvailable) {
    console.log(`[SKIP] crawl4ai service not available at ${serviceUrl}`);
    console.log('       Start the service with: crawl4ai-mcp --port 11235');
    console.log('[DONE] WebSearch crawl4ai test skipped');
    return;
  }

  // 测试 WebSearchFeature 的工具暴露
  const agent = new BasicAgent({
    llm: new MockLLM(),
    name: 'websearch-crawl4ai-test',
    mcpServer: false,
  }).use(new WebSearchFeature());

  try {
    await agent.onCall('smoke test');

    const toolNames = agent.getTools().getAll().map(tool => tool.name).sort();
    const webFetchTools = toolNames.filter(name => name === 'web_fetch');
    const crawl4aiTools = toolNames.filter(name => name.startsWith('websearch_crawl4ai_'));
    const duplicatedMCPTools = toolNames.filter(name => name.startsWith('mcp_crawl4ai_official_'));

    assert(webFetchTools.length === 1, 'ProgrammingHelperAgent should expose web_fetch');
    assert(crawl4aiTools.length > 0, 'ProgrammingHelperAgent should expose crawl4ai tools via WebSearchFeature');
    assert(duplicatedMCPTools.length === 0, 'ProgrammingHelperAgent should not expose duplicate global crawl4ai MCP tools');

    console.log(`[PASS] web_fetch registered: ${webFetchTools.join(', ')}`);
    console.log(`[PASS] crawl4ai tools registered: ${crawl4aiTools.length}`);
    console.log(`  ${crawl4aiTools.slice(0, 5).join(', ')}${crawl4aiTools.length > 5 ? ' ...' : ''}`);

    const markdownTool = agent.getTools().get('websearch_crawl4ai_md');
    assert(markdownTool !== undefined, 'Agent should expose websearch_crawl4ai_md');

    const markdownResult = await markdownTool!.execute({ url: 'https://example.com' });
    const markdownContent = typeof markdownResult?.content === 'string'
      ? markdownResult.content
      : JSON.stringify(markdownResult);

    assert(markdownContent.includes('Example Domain'), 'crawl4ai md tool should return page content');
    console.log('[PASS] websearch_crawl4ai_md returned fetched page content');
    console.log('[DONE] WebSearch crawl4ai test passed');
  } finally {
    await agent.dispose();
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
