import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ViewerWorker } from '../core/viewer-worker.js';

function getStructuredToolPayload(result: any): any {
  if (result?.structuredContent) {
    return result.structuredContent;
  }

  const textBlock = Array.isArray(result?.content)
    ? result.content.find((item: any) => item?.type === 'text' && typeof item.text === 'string')
    : undefined;

  if (!textBlock?.text) {
    return undefined;
  }

  return JSON.parse(textBlock.text);
}

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-viewer-test-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-viewer-test-${process.pid}-${Date.now()}.sock`;
}

describe('Debugger MCP', () => {
  let worker: ViewerWorker;
  let transport: StreamableHTTPClientTransport;
  let client: Client;
  let port: number;

  beforeAll(async () => {
    worker = new ViewerWorker(0, false, getTestUdsPath());
    await worker.start();

    const address = (worker as any).server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    const hookInspector = {
      lifecycleOrder: ['CallStart', 'ToolUse'],
      features: [{
        name: 'shell',
        enabled: true,
        status: 'enabled' as const,
        hookCount: 1,
        toolCount: 2,
        enabledToolCount: 2,
        source: '/tmp/shell.ts',
        description: 'Shell feature',
        tools: [
          { name: 'bash', description: 'Run bash', enabled: true, renderCall: 'bash', renderResult: 'bash' },
          { name: 'trash_delete', description: 'Move file to trash', enabled: true, renderCall: 'trash', renderResult: 'trash' },
        ],
      }],
      hooks: [{
        lifecycle: 'ToolUse',
        kind: 'decision' as const,
        entries: [{
          order: 1,
          featureName: 'shell',
          methodName: 'onToolUse',
          lifecycle: 'ToolUse',
          kind: 'decision' as const,
          source: { file: '/tmp/shell.ts', line: 12, column: 3, display: '/tmp/shell.ts:12:3' },
          description: 'Blocks risky commands',
        }],
      }],
    };

    worker.handleRegisterAgent({
      type: 'register-agent',
      agentId: 'agent-test-1',
      name: 'DebuggerTestAgent',
      createdAt: Date.now(),
      projectRoot: process.cwd(),
      hookInspector,
    });

    worker.handlePushNotification({
      type: 'push-notification',
      agentId: 'agent-test-1',
      notification: {
        type: 'log.entry',
        category: 'event',
        timestamp: Date.now(),
        data: {
          id: 'log-1',
          timestamp: Date.now(),
          level: 'error',
          message: 'Tool execution failed',
          namespace: 'agent.tool',
          context: {
            agentId: 'agent-test-1',
            agentName: 'DebuggerTestAgent',
            feature: 'shell',
            lifecycle: 'ToolUse',
          },
          data: { toolName: 'bash', code: 'EACCES' },
        },
      },
    });

    for (let index = 0; index < 240; index += 1) {
      worker.handlePushNotification({
        type: 'push-notification',
        agentId: 'agent-test-1',
        notification: {
          type: 'log.entry',
          category: 'event',
          timestamp: Date.now() + index + 1,
          data: {
            id: `log-seeded-${index}`,
            timestamp: Date.now() + index + 1,
            level: 'info',
            message: `Seeded log ${index}`,
            namespace: 'agent.seed',
            context: { agentId: 'agent-test-1', agentName: 'DebuggerTestAgent' },
          },
        },
      });
    }

    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    client = new Client({ name: 'debugger-mcp-test-client', version: '0.1.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await transport.close();
    await worker.stop();
  });

  it('should expose tools, resources, and prompts', async () => {
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === 'query_logs')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'get_hooks')).toBe(true);

    const resources = await client.listResources();
    expect(resources.resources.some(r => r.uri === 'debug://agents')).toBe(true);
    expect(resources.resources.some(r => r.uri === 'debug://agents/current')).toBe(true);

    const resourceTemplates = await client.listResourceTemplates();
    expect(resourceTemplates.resourceTemplates.some(r => r.uriTemplate === 'debug://agents/{agentId}')).toBe(true);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.some(p => p.name === 'diagnose_agent')).toBe(true);
  });

  it('should return current agent in resource', async () => {
    const resource = await client.readResource({ uri: 'debug://agents/current' });
    const text = resource.contents[0] && 'text' in resource.contents[0]
      ? (resource.contents[0] as any).text
      : undefined;
    expect(text).toContain('DebuggerTestAgent');
  });

  it('should query logs with filters', async () => {
    const result = await client.callTool({
      name: 'query_logs',
      arguments: { level: 'error', feature: 'shell', limit: 10 },
    });
    const payload = getStructuredToolPayload(result);

    expect(Array.isArray(payload?.logs)).toBe(true);
    expect(payload.logs).toHaveLength(1);
    expect(payload?.collectionPolicy?.includesOnlyHubDeliveredLogs).toBe(true);
    expect(payload?.truncation?.truncated).toBe(false);
  });

  it('should cap unbounded query and report truncation', async () => {
    const result = await client.callTool({
      name: 'query_logs',
      arguments: {},
    });
    const payload = getStructuredToolPayload(result);

    expect(payload.logs).toHaveLength(200);
    expect(payload?.truncation?.truncated).toBe(true);
    expect(payload?.truncation?.guidance).toContain('"offset": 200');
  });

  it('should return hook inspector snapshot', async () => {
    const result = await client.callTool({
      name: 'get_hooks',
      arguments: { agentId: 'agent-test-1' },
    });
    const payload = getStructuredToolPayload(result);

    expect(Array.isArray(payload?.hooks?.hooks)).toBe(true);
    expect(payload.hooks.hooks).toHaveLength(1);
  });

  it('should embed agent snapshot in diagnose prompt', async () => {
    const prompt = await client.getPrompt({
      name: 'diagnose_agent',
      arguments: { agentId: 'agent-test-1' },
    });

    expect(prompt.messages[0]?.content.type).toBe('text');
    expect((prompt.messages[0].content as any).text).toContain('DebuggerTestAgent');
  });
});
