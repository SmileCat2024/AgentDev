import { BasicAgent } from '../src/agents/index.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

class MockLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'ok' };
  }
}

function getMCPToolNames(agent: BasicAgent): string[] {
  return agent.getTools()
    .getAll()
    .map(tool => tool.name)
    .filter(name => name.startsWith('mcp_'))
    .sort();
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function collectTools(label: string, mcpServer?: string | false): Promise<string[]> {
  const agent = new BasicAgent({
    llm: new MockLLM(),
    name: `mcp-smoke-${label}`,
    mcpServer,
  });

  try {
    await agent.onCall('smoke test');
    const tools = getMCPToolNames(agent);
    console.log(`[PASS] ${label}: ${tools.length} MCP tools`);
    if (tools.length > 0) {
      console.log(`  ${tools.slice(0, 5).join(', ')}${tools.length > 5 ? ' ...' : ''}`);
    }
    return tools;
  } finally {
    await agent.dispose();
  }
}

async function main(): Promise<void> {
  const disabledTools = await collectTools('disabled', false);
  assert(disabledTools.length === 0, 'disabled mode should not register any MCP tools');

  const githubTools = await collectTools('github-only', 'github');
  assert(githubTools.length > 0, 'github-only mode should register MCP tools');
  assert(
    githubTools.every(name => name.startsWith('mcp_github_')),
    'github-only mode should only register github MCP tools'
  );

  const autoTools = await collectTools('auto');
  assert(autoTools.length >= githubTools.length, 'auto mode should register at least the github MCP tools');
  assert(
    autoTools.some(name => name.startsWith('mcp_github_')),
    'auto mode should include github MCP tools'
  );

  console.log('[DONE] MCP smoke test passed');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
