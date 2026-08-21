import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execPath } from 'process';
import { MCPConnectionManager } from '../../connection-manager.js';
import { MCPClient, createMCPTool } from '../../client.js';
import type { MCPSstdioConfig } from '../../types.js';

/**
 * SDK v2 迁移往返测试
 *
 * 验证链路：MCPConnectionManager → stdio transport → mock server → tools/list → tools/call
 * 确保从 v1 (@modelcontextprotocol/sdk) 到 v2 (@modelcontextprotocol/client) 的迁移
 * 不破坏任何核心交互。
 */

const MOCK_SERVER_CODE = [
  "process.stdin.setEncoding('utf8');",
  "let buffer = '';",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  const lines = buffer.split(/\\r?\\n/);",
  "  buffer = lines.pop() || '';",
  "  for (const line of lines) {",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  "    let result;",
  "    if (msg.method === 'initialize') {",
  "      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'round-trip-mock', version: '1.0.0' } };",
  "    } else if (msg.method === 'notifications/initialized') {",
  "      continue;",
  "    } else if (msg.method === 'tools/list') {",
  "      result = {",
  "        tools: [",
  "          { name: 'echo', description: 'Echo back the message', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },",
  "          { name: 'status', description: 'Return server status', inputSchema: { type: 'object', properties: {} } },",
  "        ],",
  "      };",
  "    } else if (msg.method === 'tools/call') {",
  "      if (msg.params.name === 'echo') {",
  "        result = { content: [{ type: 'text', text: msg.params.arguments.message }] };",
  "      } else {",
  "        result = { content: [{ type: 'text', text: 'ok' }] };",
  "      }",
  "    } else {",
  "      result = {};",
  "    }",
  "    if (msg.id !== undefined) {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');",
  "    }",
  "  }",
  "});",
].join('\n');

describe('MCP v2 round-trip', () => {
  let tempDir: string;
  let serverPath: string;
  let serverConfig: MCPSstdioConfig;
  let manager: MCPConnectionManager;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agentdev-mcp-v2-rt-'));
    serverPath = join(tempDir, 'mock-server.cjs');
    await writeFile(serverPath, MOCK_SERVER_CODE, 'utf8');

    serverConfig = {
      transport: 'stdio',
      command: execPath,
      args: [serverPath],
      cwd: tmpdir(),
    };
  });

  afterAll(async () => {
    await manager?.dispose().catch(() => undefined);
    // Retry cleanup for Windows file locks
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(tempDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  });

  it('should connect via stdio and list tools', async () => {
    manager = new MCPConnectionManager();
    await manager.connectServer('test-server', serverConfig);

    expect(manager.isConnected('test-server')).toBe(true);

    const tools = await manager.listTools('test-server');
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('echo');
    expect(tools[1].name).toBe('status');
  });

  it('should call a tool and receive text content', async () => {
    const result = await manager.callTool('echo', 'test-server', { message: 'hello v2' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('hello v2');
  });

  it('should call status tool', async () => {
    const result = await manager.callTool('status', 'test-server', {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('ok');
  });

  it('should create MCPClient wrapper and use it', async () => {
    const client = new MCPClient('wrapper-test', serverConfig, manager);
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);

    const tool = tools.find(t => t.name === 'echo')!;
    const mcpTool = createMCPTool(client, tool);
    const result = await mcpTool.execute({ message: 'via wrapper' });
    expect(result.content).toBe('via wrapper');
    expect(result.server).toBe('wrapper-test');
  });

  it('should disconnect cleanly', async () => {
    await manager.disconnectServer('test-server');
    expect(manager.isConnected('test-server')).toBe(false);
  });
});
