import { BasicAgent } from '../src/agents/index.js';
import { ProgrammingHelperAgent } from './ProgrammingHelperAgent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';
import { WebSearchFeature } from '../src/features/index.js';

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

async function main(): Promise<void> {
  const programmingAgent = new ProgrammingHelperAgent({
    llm: new MockLLM(),
    name: 'programming-helper-websearch-wiring-test',
    mcpServer: false,
  });

  try {
    assert(
      (programmingAgent as any).features?.has('websearch'),
      'ProgrammingHelperAgent should mount WebSearchFeature'
    );
    console.log('[PASS] ProgrammingHelperAgent mounts WebSearchFeature');
  } finally {
    await programmingAgent.dispose();
  }

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

    assert(webFetchTools.length === 1, 'ProgrammingHelperAgent should expose web_fetch');
    assert(crawl4aiTools.length > 0, 'ProgrammingHelperAgent should expose crawl4ai tools via WebSearchFeature');

    console.log(`[PASS] web_fetch registered: ${webFetchTools.join(', ')}`);
    console.log(`[PASS] crawl4ai tools registered: ${crawl4aiTools.length}`);
    console.log(`  ${crawl4aiTools.slice(0, 5).join(', ')}${crawl4aiTools.length > 5 ? ' ...' : ''}`);

    const markdownTool = agent.getTools().get('websearch_crawl4ai_md');
    assert(markdownTool, 'ProgrammingHelperAgent should expose websearch_crawl4ai_md');

    const markdownResult = await markdownTool.execute({ url: 'https://example.com' });
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
