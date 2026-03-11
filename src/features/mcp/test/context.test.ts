import { createMCPTool } from '../../../mcp/client.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const calls: Array<{ args: Record<string, unknown>; context: any }> = [];

  const fakeClient = {
    serverId: 'test',
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ args, context: undefined });
      return {
        content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }],
      };
    },
  };

  const tool = createMCPTool(fakeClient as any, { name: 'echo' }, {
    transformArgs: (args, context) => {
      calls.push({ args, context });
      return {
        ...args,
        token: context?._mcpContext?.token,
      };
    },
  });

  const result = await tool.execute(
    { ping: 'pong' },
    { _mcpContext: { token: 'abc123' } }
  );

  assert(calls.length === 2, 'expected transformArgs and client.callTool to be invoked');
  assert(calls[0].context?._mcpContext?.token === 'abc123', 'tool context should reach transformArgs');
  assert(calls[1].args.token === 'abc123', 'transformed args should reach client.callTool');
  assert(result.content.includes('abc123'), 'tool result should include transformed args');

  console.log('[DONE] MCP context propagation test passed');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
