import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ViewerWorker } from '../core/viewer-worker.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

async function main(): Promise<void> {
  const worker = new ViewerWorker(0, false, getTestUdsPath());
  await worker.start();

  const address = (worker as any).server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  assert(typeof port === 'number' && port > 0, 'viewer worker should listen on a dynamic port');

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
        data: {
          toolName: 'bash',
          code: 'EACCES',
        },
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
          context: {
            agentId: 'agent-test-1',
            agentName: 'DebuggerTestAgent',
          },
        },
      },
    });
  }

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({
    name: 'debugger-mcp-test-client',
    version: '0.1.0',
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert(tools.tools.some(tool => tool.name === 'query_logs'), 'query_logs tool should be listed');
    assert(tools.tools.some(tool => tool.name === 'get_hooks'), 'get_hooks tool should be listed');

    const resources = await client.listResources();
    assert(resources.resources.some(resource => resource.uri === 'debug://agents'), 'agents resource should be listed');
    assert(resources.resources.some(resource => resource.uri === 'debug://agents/current'), 'current agent resource should be listed');

    const resourceTemplates = await client.listResourceTemplates();
    assert(
      resourceTemplates.resourceTemplates.some(resource => resource.uriTemplate === 'debug://agents/{agentId}'),
      'agent details resource template should be listed'
    );

    const prompts = await client.listPrompts();
    assert(prompts.prompts.some(prompt => prompt.name === 'diagnose_agent'), 'diagnose_agent prompt should be listed');

    const currentAgentResource = await client.readResource({ uri: 'debug://agents/current' });
    const currentAgentText = currentAgentResource.contents[0] && 'text' in currentAgentResource.contents[0]
      ? currentAgentResource.contents[0].text
      : undefined;
    assert(currentAgentText?.includes('DebuggerTestAgent'), 'current agent resource should include agent name');

    const logsResult = await client.callTool({
      name: 'query_logs',
      arguments: {
        level: 'error',
        feature: 'shell',
        limit: 10,
      },
    });
    const logsPayload = getStructuredToolPayload(logsResult);
    assert(
      Array.isArray(logsPayload?.logs) &&
      logsPayload.logs.length === 1,
      'query_logs should return the seeded error log'
    );
    assert(
      logsPayload?.collectionPolicy?.includesOnlyHubDeliveredLogs === true,
      'query_logs should explain that only hub-delivered logs are included'
    );
    assert(
      logsPayload?.truncation?.truncated === false,
      'filtered query_logs result should not report truncation'
    );

    const unboundedLogsResult = await client.callTool({
      name: 'query_logs',
      arguments: {},
    });
    const unboundedLogsPayload = getStructuredToolPayload(unboundedLogsResult);
    assert(
      Array.isArray(unboundedLogsPayload?.logs) &&
      unboundedLogsPayload.logs.length === 200,
      'unbounded query_logs should be capped to the default safety limit'
    );
    assert(
      unboundedLogsPayload?.truncation?.truncated === true,
      'unbounded query_logs should report truncation'
    );
    assert(
      typeof unboundedLogsPayload?.truncation?.guidance === 'string' &&
      unboundedLogsPayload.truncation.guidance.includes('"offset": 200'),
      'unbounded query_logs should explain how to continue with explicit parameters'
    );

    const hooksResult = await client.callTool({
      name: 'get_hooks',
      arguments: {
        agentId: 'agent-test-1',
      },
    });
    const hooksPayload = getStructuredToolPayload(hooksResult);
    assert(
      Array.isArray(hooksPayload?.hooks?.hooks) &&
      hooksPayload.hooks.hooks.length === 1,
      'get_hooks should return the seeded hook inspector'
    );

    const diagnosePrompt = await client.getPrompt({
      name: 'diagnose_agent',
      arguments: {
        agentId: 'agent-test-1',
      },
    });
    assert(
      diagnosePrompt.messages[0]?.content.type === 'text' &&
      diagnosePrompt.messages[0].content.text.includes('DebuggerTestAgent'),
      'diagnose prompt should embed the agent snapshot'
    );

    console.log('[PASS] debugger MCP server exposes tools, resources, and prompts');
  } finally {
    await transport.close();
    await worker.stop();
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
