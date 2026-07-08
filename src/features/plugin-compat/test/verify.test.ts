import { describe, it, expect } from 'vitest';
import { CompatHookRegistry } from '../registry.js';
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
} from '../types.js';

describe('PluginCompat CompatHookRegistry', () => {
  it('should execute hooks in priority order (descending)', async () => {
    const registry = new CompatHookRegistry();
    const executionOrder: string[] = [];

    registry.register(
      'before_tool_call',
      async (): Promise<BeforeToolCallResult> => { executionOrder.push('A'); return {}; },
      0,
      'plugin-a'
    );
    registry.register(
      'before_tool_call',
      async (): Promise<BeforeToolCallResult> => { executionOrder.push('B'); return {}; },
      10,
      'plugin-b'
    );
    registry.register(
      'before_tool_call',
      async (): Promise<BeforeToolCallResult> => { executionOrder.push('C'); return {}; },
      -5,
      'plugin-c'
    );

    await registry.executeBeforeToolCall({
      call: { id: '123', name: 'test', arguments: {} } as any,
      toolName: 'test',
      parameters: {},
      messages: [],
    });

    expect(executionOrder).toEqual(['B', 'A', 'C']);
  });

  it('should block dangerous tools in before_tool_call', async () => {
    const registry = new CompatHookRegistry();

    registry.register(
      'before_tool_call',
      async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult> => {
        if (ctx.toolName === 'dangerous_tool') {
          return { block: true, denyReason: 'Dangerous tool blocked' };
        }
        return {};
      },
      0,
      'security-plugin'
    );

    const blocked = await registry.executeBeforeToolCall({
      call: { id: '123', name: 'dangerous_tool', arguments: {} } as any,
      toolName: 'dangerous_tool',
      parameters: {},
      messages: [],
    });

    expect(blocked.block).toBe(true);
    expect(blocked.denyReason).toBe('Dangerous tool blocked');

    const allowed = await registry.executeBeforeToolCall({
      call: { id: '123', name: 'safe_tool', arguments: {} } as any,
      toolName: 'safe_tool',
      parameters: {},
      messages: [],
    });

    expect(allowed.block).toBeFalsy();
  });

  it('should rewrite parameters in before_tool_call', async () => {
    const registry = new CompatHookRegistry();

    registry.register(
      'before_tool_call',
      async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult> => {
        if (ctx.toolName === 'echo') {
          return {
            rewrittenParameters: {
              message: `[MODIFIED] ${(ctx.parameters as any).message}`,
            },
          };
        }
        return {};
      },
      0,
      'modifier-plugin'
    );

    const result = await registry.executeBeforeToolCall({
      call: { id: '123', name: 'echo', arguments: { message: 'hello' } } as any,
      toolName: 'echo',
      parameters: { message: 'hello' },
      messages: [],
    });

    expect(result.rewrittenParameters).toBeDefined();
    expect((result.rewrittenParameters as any).message).toBe('[MODIFIED] hello');
  });

  it('should notify after_tool_call hooks', async () => {
    const registry = new CompatHookRegistry();
    const log: string[] = [];

    registry.register(
      'after_tool_call',
      async (ctx: AfterToolCallContext) => {
        log.push(`${ctx.toolName}:${ctx.success}`);
      },
      0,
      'logger-plugin'
    );

    await registry.executeAfterToolCall({
      call: { id: '123', name: 'test', arguments: {} } as any,
      toolName: 'test',
      success: true,
      result: 'done',
      duration: 100,
      messages: [],
    });

    expect(log).toEqual(['test:true']);
  });
});
