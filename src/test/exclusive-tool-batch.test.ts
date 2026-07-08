/**
 * Exclusive Tool Batch 测试
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

// ========== Mock LLM ==========

class ExclusiveBatchLLM implements LLMClient {
  private callCount = 0;

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.callCount++;
    const hasToolResults = messages.some(m => m.role === 'tool');

    if (this.callCount === 1) {
      return {
        content: 'I will checkpoint and read a file.',
        toolCalls: [
          { id: 'tc_1', name: 'checkpoint', arguments: { checkpointId: 'cp-1' } },
          { id: 'tc_2', name: 'read_file', arguments: { path: 'test.txt' } },
        ],
      };
    }

    if (this.callCount === 2) {
      const toolResults = messages.filter(m => m.role === 'tool');
      const allFailed = toolResults.every(m => m.content.includes('must be the only tool call'));

      if (allFailed) {
        return {
          content: 'Retrying with only checkpoint.',
          toolCalls: [
            { id: 'tc_3', name: 'checkpoint', arguments: { checkpointId: 'cp-1' } },
          ],
        };
      }
    }

    return { content: 'Task completed.' };
  }
}

class DoubleExclusiveLLM implements LLMClient {
  private callCount = 0;

  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.callCount++;

    if (this.callCount === 1) {
      return {
        content: 'Calling two exclusive tools.',
        toolCalls: [
          { id: 'tc_1', name: 'checkpoint', arguments: { checkpointId: 'cp-a' } },
          { id: 'tc_2', name: 'rollback', arguments: { checkpointId: 'cp-b', summary: 'test' } },
        ],
      };
    }

    return { content: 'Done.' };
  }
}

class SingleExclusiveLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const hasToolResults = messages.some(m => m.role === 'tool');
    if (!hasToolResults) {
      return {
        content: 'Creating checkpoint.',
        toolCalls: [
          { id: 'tc_1', name: 'checkpoint', arguments: { checkpointId: 'cp-1' } },
        ],
      };
    }
    return { content: 'Checkpoint done.' };
  }
}

class SingleNormalLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const hasToolResults = messages.some(m => m.role === 'tool');
    if (!hasToolResults) {
      return {
        content: 'Reading file.',
        toolCalls: [
          { id: 'tc_1', name: 'read_file', arguments: { path: 'test.txt' } },
        ],
      };
    }
    return { content: 'File read done.' };
  }
}

// ========== Agent 子类 ==========

class ExclusiveTestAgent extends Agent {
  constructor(llm: LLMClient, tools: Tool[]) {
    super({ llm, maxTurns: 5, name: 'ExclusiveTestAgent', tools });
  }
}

// ========== 测试用例 ==========

describe('Exclusive tool batch', () => {
  it('should reject mixed exclusive + normal and allow model retry', async () => {
    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'checkpoint',
        description: 'Create a checkpoint',
        executionMode: 'exclusive',
        execute: async () => {
          executedTools.push('checkpoint');
          return 'checkpoint created';
        },
      },
      {
        name: 'read_file',
        description: 'Read a file',
        execute: async () => {
          executedTools.push('read_file');
          return 'file content';
        },
      },
    ];

    const agent = new ExclusiveTestAgent(new ExclusiveBatchLLM(), tools);
    await agent.onCall('Test exclusive batch');

    expect(executedTools.includes('checkpoint')).toBe(true);
    expect(executedTools.includes('read_file')).toBe(false);

    const messages = agent.getContext().getAll();
    const toolMessages = messages.filter(m => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(3);

    const rejectedResults = toolMessages.filter(m => m.content.includes('must be the only tool call'));
    expect(rejectedResults).toHaveLength(2);
  });

  it('should reject double exclusive batch', async () => {
    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'checkpoint',
        description: 'Create a checkpoint',
        executionMode: 'exclusive',
        execute: async () => {
          executedTools.push('checkpoint');
          return 'checkpoint created';
        },
      },
      {
        name: 'rollback',
        description: 'Rollback to checkpoint',
        executionMode: 'exclusive',
        execute: async () => {
          executedTools.push('rollback');
          return 'rolled back';
        },
      },
    ];

    const agent = new ExclusiveTestAgent(new DoubleExclusiveLLM(), tools);
    await agent.onCall('Test double exclusive');

    expect(executedTools.includes('checkpoint')).toBe(false);
    expect(executedTools.includes('rollback')).toBe(false);

    const messages = agent.getContext().getAll();
    const toolMessages = messages.filter(m => m.role === 'tool');
    const rejectedResults = toolMessages.filter(m => m.content.includes('exclusive tool'));
    expect(rejectedResults).toHaveLength(2);
  });

  it('should execute single exclusive tool normally', async () => {
    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'checkpoint',
        description: 'Create a checkpoint',
        executionMode: 'exclusive',
        execute: async () => {
          executedTools.push('checkpoint');
          return 'checkpoint created';
        },
      },
    ];

    const agent = new ExclusiveTestAgent(new SingleExclusiveLLM(), tools);
    const response = await agent.onCall('Test single exclusive');

    expect(executedTools.includes('checkpoint')).toBe(true);
    expect(response).toContain('Checkpoint done.');
  });

  it('should leave normal tool behavior unchanged', async () => {
    const executedTools: string[] = [];
    const tools: Tool[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        execute: async () => {
          executedTools.push('read_file');
          return 'file content';
        },
      },
    ];

    const agent = new ExclusiveTestAgent(new SingleNormalLLM(), tools);
    const response = await agent.onCall('Test normal tool');

    expect(executedTools.includes('read_file')).toBe(true);
    expect(response).toContain('File read done.');
  });
});
