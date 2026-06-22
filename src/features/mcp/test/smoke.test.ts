import { BasicAgent } from '../../../agents/index.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../../../core/types.js';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { chdir, cwd, execPath } from 'process';

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

async function createMockMCPWorkspace(): Promise<{ tempDir: string; githubConfigPath: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'agentdev-mcp-smoke-'));
  const configDir = join(tempDir, '.agentdev', 'mcps');
  const serverPath = join(tempDir, 'mock-mcp-server.cjs');
  const githubConfigPath = join(configDir, 'github.json');
  const extraConfigPath = join(configDir, 'extra.json');

  await mkdir(configDir, { recursive: true });
  await writeFile(serverPath, `
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const toolName = process.env.MOCK_MCP_TOOL_NAME || 'status';
    const result = request.method === 'tools/list'
      ? { tools: [{ name: toolName, description: 'Mock MCP tool', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'ok' }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`, 'utf8');

  const createConfig = (serverId: string, toolName: string) => JSON.stringify({
    servers: {
      [serverId]: {
        transport: 'stdio',
        command: execPath,
        args: [serverPath],
        cwd: tmpdir(),
        env: {
          MOCK_MCP_TOOL_NAME: toolName,
        },
      },
    },
  }, null, 2);

  await writeFile(githubConfigPath, createConfig('github', 'repo_info'), 'utf8');
  await writeFile(extraConfigPath, createConfig('extra', 'status'), 'utf8');

  return { tempDir, githubConfigPath };
}

async function removeTempDir(tempDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

async function main(): Promise<void> {
  const originalCwd = cwd();
  const { tempDir, githubConfigPath } = await createMockMCPWorkspace();

  try {
    chdir(tempDir);

    const disabledTools = await collectTools('disabled', false);
    assert(disabledTools.length === 0, 'disabled mode should not register any MCP tools');

    const githubTools = await collectTools('github-only', githubConfigPath);
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
    assert(
      autoTools.some(name => name.startsWith('mcp_extra_')),
      'auto mode should include all local MCP config files'
    );

    console.log('[DONE] MCP smoke test passed');
  } finally {
    chdir(originalCwd);
    await removeTempDir(tempDir);
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
