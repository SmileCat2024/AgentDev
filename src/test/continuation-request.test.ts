/**
 * Continuation Request 测试
 */

import { describe, it, expect } from 'vitest';
import { Agent } from '../core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

// ========== Mock LLM ==========

class CheckpointLLM implements LLMClient {
  chatCount = 0;

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.chatCount++;
    const hasToolResults = messages.some(m => m.role === 'tool');

    if (!hasToolResults) {
      return {
        content: 'Creating a checkpoint.',
        toolCalls: [
          { id: 'tc_cp', name: 'checkpoint', arguments: { checkpointId: 'cp-test' } },
        ],
      };
    }

    return { content: 'should not reach here' };
  }
}

class RollbackLLM implements LLMClient {
  chatCount = 0;

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.chatCount++;
    const hasToolResults = messages.some(m => m.role === 'tool');

    if (!hasToolResults) {
      return {
        content: 'Rolling back.',
        toolCalls: [
          { id: 'tc_rb', name: 'rollback_to_checkpoint', arguments: { checkpointId: 'cp-test', summary: 'tried A, failed because B' } },
        ],
      };
    }

    return { content: 'should not reach here' };
  }
}

class NormalCompletionLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'Task done.' };
  }
}

// ========== 测试用例 ==========

const checkpointTool: Tool[] = [
  {
    name: 'checkpoint',
    description: 'Create a checkpoint',
    executionMode: 'exclusive',
    execute: async (args: any, context?: any) => {
      context?.registerContinuationRequest({
        kind: 'checkpoint',
        checkpointId: args.checkpointId,
      });
      return `Checkpoint "${args.checkpointId}" has been established.`;
    },
  },
];

describe('Continuation Request', () => {
  it('should register continuation, stop LLM loop, and consume once', async () => {
    const llm = new CheckpointLLM();

    const agent = new (class extends Agent {
      constructor() {
        super({ llm, maxTurns: 5, name: 'CheckpointAgent', tools: checkpointTool });
      }
    })();

    const response = await agent.onCall('Do something with checkpoint');

    expect(llm.chatCount).toBe(1);
    expect(typeof response).toBe('string');

    const request = agent.consumeContinuationRequest();
    expect(request).not.toBeNull();
    expect(request!.kind).toBe('checkpoint');
    expect((request as any).checkpointId).toBe('cp-test');

    expect(agent.consumeContinuationRequest()).toBeNull();
  });

  it('should register rollback continuation with summary', async () => {
    const llm = new RollbackLLM();

    const tools: Tool[] = [
      {
        name: 'rollback_to_checkpoint',
        description: 'Rollback to checkpoint',
        executionMode: 'exclusive',
        execute: async (args: any, context?: any) => {
          context?.registerContinuationRequest({
            kind: 'rollback',
            checkpointId: args.checkpointId,
            summary: args.summary,
          });
          return 'Rollback requested.';
        },
      },
    ];

    const agent = new (class extends Agent {
      constructor() {
        super({ llm, maxTurns: 5, name: 'RollbackAgent', tools });
      }
    })();

    await agent.onCall('Try and rollback');

    const request = agent.consumeContinuationRequest();
    expect(request).not.toBeNull();
    expect(request!.kind).toBe('rollback');
    expect((request as any).checkpointId).toBe('cp-test');
    expect((request as any).summary).toBe('tried A, failed because B');
  });

  it('should clear stale request at onCall start', async () => {
    const checkpointLLM = new CheckpointLLM();
    const normalLLM = new NormalCompletionLLM();

    // Agent with stale request (not consumed)
    const agent1 = new (class extends Agent {
      constructor() {
        super({ llm: checkpointLLM, maxTurns: 5, name: 'StaleAgent', tools: checkpointTool });
      }
    })();

    await agent1.onCall('First call with checkpoint');
    // Don't consume — leaves stale request

    // Different agent, normal call — should have no continuation
    const agent2 = new (class extends Agent {
      constructor() {
        super({ llm: normalLLM, maxTurns: 5, name: 'NormalAgent' });
      }
    })();

    await agent2.onCall('Normal call');
    expect(agent2.consumeContinuationRequest()).toBeNull();

    // Same agent: second onCall clears stale request
    const checkpointLLM2 = new CheckpointLLM();
    const agent3 = new (class extends Agent {
      constructor() {
        super({ llm: checkpointLLM2, maxTurns: 5, name: 'StaleAgent3', tools: checkpointTool });
      }
    })();

    await agent3.onCall('Register checkpoint');

    (agent3 as any).llm = normalLLM;
    await agent3.onCall('Normal follow-up');
    expect(agent3.consumeContinuationRequest()).toBeNull();
  });

  it('should throw on double registration and retain first request', async () => {
    const llm = new CheckpointLLM();

    const tools: Tool[] = [
      {
        name: 'checkpoint',
        description: 'Create a checkpoint',
        executionMode: 'exclusive',
        execute: async (_args: any, context?: any) => {
          context?.registerContinuationRequest({ kind: 'checkpoint', checkpointId: 'cp-1' });
          expect(() => {
            context?.registerContinuationRequest({ kind: 'checkpoint', checkpointId: 'cp-2' });
          }).toThrow(/already registered/);
          return 'Checkpoint created.';
        },
      },
    ];

    const agent = new (class extends Agent {
      constructor() {
        super({ llm, maxTurns: 5, name: 'DoubleRegisterAgent', tools });
      }
    })();

    await agent.onCall('Test double register');

    const request = agent.consumeContinuationRequest();
    expect(request).not.toBeNull();
    expect((request as any).checkpointId).toBe('cp-1');
  });
});
