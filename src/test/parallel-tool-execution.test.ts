/**
 * Parallel Tool Execution 测试
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

// ========== Mock LLM ==========

class ParallelBatchLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const hasToolResults = messages.some(m => m.role === 'tool');
    if (!hasToolResults) {
      return {
        content: 'Reading two files in parallel.',
        toolCalls: [
          { id: 'tc_1', name: 'read_a', arguments: {} },
          { id: 'tc_2', name: 'read_b', arguments: {} },
        ],
      };
    }
    return { content: 'Done reading.' };
  }
}

class MixedBatchLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const hasToolResults = messages.some(m => m.role === 'tool');
    if (!hasToolResults) {
      return {
        content: 'Mixed batch: read, write, grep.',
        toolCalls: [
          { id: 'tc_1', name: 'read_a', arguments: {} },
          { id: 'tc_2', name: 'write_c', arguments: {} },
          { id: 'tc_3', name: 'grep_d', arguments: {} },
        ],
      };
    }
    return { content: 'Done.' };
  }
}

class AllSerialLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const hasToolResults = messages.some(m => m.role === 'tool');
    if (!hasToolResults) {
      return {
        content: 'Two serial tools.',
        toolCalls: [
          { id: 'tc_1', name: 'write_a', arguments: {} },
          { id: 'tc_2', name: 'write_b', arguments: {} },
        ],
      };
    }
    return { content: 'Done.' };
  }
}

class ParallelTestAgent extends Agent {
  constructor(llm: LLMClient, tools: Tool[]) {
    super({ llm, maxTurns: 5, name: 'ParallelTestAgent', tools });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 测试用例 ==========

describe('Parallel tool execution', () => {
  it('should execute two parallelizable tools with results in original order', async () => {
    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'read_a',
        description: 'Read file A',
        parallelizable: true,
        execute: async () => { executedTools.push('read_a'); return 'content_a'; },
      },
      {
        name: 'read_b',
        description: 'Read file B',
        parallelizable: true,
        execute: async () => { executedTools.push('read_b'); return 'content_b'; },
      },
    ];

    const agent = new ParallelTestAgent(new ParallelBatchLLM(), tools);
    await agent.onCall('Read two files');

    expect(executedTools).toHaveLength(2);
    expect(executedTools).toContain('read_a');
    expect(executedTools).toContain('read_b');

    const toolMessages = agent.getContext().getAll().filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].toolCallId).toBe('tc_1');
    expect(toolMessages[1].toolCallId).toBe('tc_2');
    expect(toolMessages[0].content).toContain('content_a');
    expect(toolMessages[1].content).toContain('content_b');
  });

  it('should handle mixed batch [parallel, serial, parallel] with results in original order', async () => {
    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'read_a',
        description: 'Read file A',
        parallelizable: true,
        execute: async () => { executedTools.push('read_a'); return 'content_a'; },
      },
      {
        name: 'write_c',
        description: 'Write file C',
        execute: async () => { executedTools.push('write_c'); return 'written_c'; },
      },
      {
        name: 'grep_d',
        description: 'Grep search',
        parallelizable: true,
        execute: async () => { executedTools.push('grep_d'); return 'grep_result'; },
      },
    ];

    const agent = new ParallelTestAgent(new MixedBatchLLM(), tools);
    await agent.onCall('Mixed batch');

    expect(executedTools).toHaveLength(3);

    const toolMessages = agent.getContext().getAll().filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0].toolCallId).toBe('tc_1');
    expect(toolMessages[1].toolCallId).toBe('tc_2');
    expect(toolMessages[2].toolCallId).toBe('tc_3');
  });

  it('should fall back to serial when no parallelizable tools', async () => {
    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'write_a',
        description: 'Write file A',
        execute: async () => { executedTools.push('write_a'); return 'written_a'; },
      },
      {
        name: 'write_b',
        description: 'Write file B',
        execute: async () => { executedTools.push('write_b'); return 'written_b'; },
      },
    ];

    const agent = new ParallelTestAgent(new AllSerialLLM(), tools);
    await agent.onCall('Two serial tools');

    expect(executedTools).toHaveLength(2);

    const toolMessages = agent.getContext().getAll().filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].toolCallId).toBe('tc_1');
    expect(toolMessages[1].toolCallId).toBe('tc_2');
  });

  it('should truly execute parallelizable tools concurrently', async () => {
    class SlowParallelLLM implements LLMClient {
      async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
        const hasToolResults = messages.some(m => m.role === 'tool');
        if (!hasToolResults) {
          return {
            content: 'Reading two slow files.',
            toolCalls: [
              { id: 'tc_1', name: 'slow_read_a', arguments: {} },
              { id: 'tc_2', name: 'slow_read_b', arguments: {} },
            ],
          };
        }
        return { content: 'Done.' };
      }
    }

    const tools: Tool[] = [
      {
        name: 'slow_read_a',
        description: 'Slow read A',
        parallelizable: true,
        execute: async () => { await sleep(200); return 'slow_a'; },
      },
      {
        name: 'slow_read_b',
        description: 'Slow read B',
        parallelizable: true,
        execute: async () => { await sleep(200); return 'slow_b'; },
      },
    ];

    const agent = new ParallelTestAgent(new SlowParallelLLM(), tools);
    const startTime = Date.now();
    await agent.onCall('Read two slow files');
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(380);
  });

  it('should still reject exclusive + parallelizable mixed batch', async () => {
    class ExclusiveMixedLLM implements LLMClient {
      async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
        const hasToolResults = messages.some(m => m.role === 'tool');
        if (!hasToolResults) {
          return {
            content: 'Exclusive + parallel.',
            toolCalls: [
              { id: 'tc_1', name: 'checkpoint', arguments: {} },
              { id: 'tc_2', name: 'read_x', arguments: {} },
            ],
          };
        }
        return { content: 'Done.' };
      }
    }

    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'checkpoint',
        description: 'Checkpoint',
        executionMode: 'exclusive',
        execute: async () => { executedTools.push('checkpoint'); return 'cp'; },
      },
      {
        name: 'read_x',
        description: 'Read X',
        parallelizable: true,
        execute: async () => { executedTools.push('read_x'); return 'content_x'; },
      },
    ];

    const agent = new ParallelTestAgent(new ExclusiveMixedLLM(), tools);
    await agent.onCall('Exclusive + parallel');

    const toolMessages = agent.getContext().getAll().filter(m => m.role === 'tool');
    const rejected = toolMessages.filter(m => m.content.includes('must be the only tool call'));
    expect(rejected).toHaveLength(2);
  });
});
