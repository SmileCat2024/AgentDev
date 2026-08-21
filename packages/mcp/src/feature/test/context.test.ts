import { describe, it, expect } from 'vitest';
import { createMCPTool } from '../../../mcp/client.js';

describe('MCP context propagation', () => {
  it('should propagate tool context to transformArgs and client.callTool', async () => {
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

    expect(calls).toHaveLength(2);
    expect(calls[0].context?._mcpContext?.token).toBe('abc123');
    expect(calls[1].args.token).toBe('abc123');
    expect(result.content).toContain('abc123');
  });
});
