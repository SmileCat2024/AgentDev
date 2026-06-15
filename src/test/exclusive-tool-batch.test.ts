/**
 * Exclusive Tool Batch 测试
 *
 * 验证：
 * 1. 单独调用普通工具，行为不变
 * 2. 单独调用 exclusive 工具，正常执行
 * 3. exclusive + 普通工具混用，全批次不执行，补齐失败 result
 * 4. 两个 exclusive 工具同批次，全批次不执行
 * 5. 校验失败后模型可在下一步重试
 */

import { Agent } from '../core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool, ToolCall } from '../core/types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// ========== Mock LLM ==========

class ExclusiveBatchLLM implements LLMClient {
  private callCount = 0;

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.callCount++;
    const hasToolResults = messages.some(m => m.role === 'tool');

    if (this.callCount === 1) {
      // Step 0: 返回 exclusive + normal 混用
      return {
        content: 'I will checkpoint and read a file.',
        toolCalls: [
          { id: 'tc_1', name: 'checkpoint', arguments: { checkpointId: 'cp-1' } },
          { id: 'tc_2', name: 'read_file', arguments: { path: 'test.txt' } },
        ],
      };
    }

    if (this.callCount === 2 && !hasToolResults) {
      // Should not reach here - but just in case
      return { content: 'unexpected' };
    }

    // Step 1: 看到 rejection result 后，只调用 exclusive 工具
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

    // Step 2+: 最终回复
    return { content: 'Task completed.' };
  }
}

class DoubleExclusiveLLM implements LLMClient {
  private callCount = 0;

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
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
  private toolExecuted: string[] = [];

  constructor(llm: LLMClient, tools: Tool[]) {
    super({ llm, maxTurns: 5, name: 'ExclusiveTestAgent', tools });
  }

  getExecutedTools(): string[] {
    return this.toolExecuted;
  }
}

// ========== 测试用例 ==========

async function testExclusiveMixedWithNormal(): Promise<void> {
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
  const response = await agent.onCall('Test exclusive batch');

  // 验证：第一步两个工具都没有执行
  // 验证：第二步只执行了 checkpoint
  assert(executedTools.includes('checkpoint'), 'checkpoint should have been executed on retry');
  assert(!executedTools.includes('read_file') || executedTools.indexOf('read_file') === -1,
    'read_file should not have been executed in the mixed batch');

  // 验证：Context 中有失败 tool result（来自混用拒绝）
  const messages = agent.getContext().getAll();
  const toolMessages = messages.filter(m => m.role === 'tool');
  assert(toolMessages.length >= 3, 'should have at least 3 tool results (2 rejected + 1 successful)');

  // 第两个 tool result 应该包含错误信息
  const rejectedResults = toolMessages.filter(m => m.content.includes('must be the only tool call'));
  assert(rejectedResults.length === 2, 'both rejected tool calls should have error messages');

  console.log('[PASS] Exclusive + normal mixed batch: all rejected, model retries with single tool');
}

async function testDoubleExclusive(): Promise<void> {
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

  // 两个 exclusive 工具都不应该执行
  assert(!executedTools.includes('checkpoint'), 'checkpoint should not execute in double-exclusive batch');
  assert(!executedTools.includes('rollback'), 'rollback should not execute in double-exclusive batch');

  const messages = agent.getContext().getAll();
  const toolMessages = messages.filter(m => m.role === 'tool');
  const rejectedResults = toolMessages.filter(m => m.content.includes('exclusive tool'));
  assert(rejectedResults.length === 2, 'both exclusive tools should have rejection messages');

  console.log('[PASS] Double exclusive batch: all rejected with proper error');
}

async function testSingleExclusiveExecutes(): Promise<void> {
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

  assert(executedTools.includes('checkpoint'), 'single exclusive tool should execute normally');
  assert(response.includes('Checkpoint done.'), 'agent should complete after exclusive tool');

  console.log('[PASS] Single exclusive tool: executes normally');
}

async function testNormalToolUnchanged(): Promise<void> {
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

  assert(executedTools.includes('read_file'), 'normal tool should execute');
  assert(response.includes('File read done.'), 'agent should complete normally');

  console.log('[PASS] Normal tool: behavior unchanged');
}

async function main(): Promise<void> {
  await testNormalToolUnchanged();
  await testSingleExclusiveExecutes();
  await testExclusiveMixedWithNormal();
  await testDoubleExclusive();

  console.log('\nAll exclusive tool batch tests passed.');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
