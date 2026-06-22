/**
 * Parallel Tool Execution 测试
 *
 * 验证：
 * 1. 两个 parallelizable 工具同时执行，结果按原始顺序注入
 * 2. 混合批次 [parallel, serial, parallel] — 结果按原始顺序注入
 * 3. 全串行回退：批次中无 parallelizable 工具时正常工作
 * 4. parallelizable 工具真正并发执行（通过时间验证）
 */

import { Agent } from '../core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool, ToolCall } from '../core/types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// ========== Mock LLM ==========

class ParallelBatchLLM implements LLMClient {
  private callCount = 0;

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.callCount++;
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
  private callCount = 0;

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.callCount++;
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

// ========== Agent 子类 ==========

class ParallelTestAgent extends Agent {
  constructor(llm: LLMClient, tools: Tool[]) {
    super({ llm, maxTurns: 5, name: 'ParallelTestAgent', tools });
  }
}

// ========== 测试用例 ==========

/**
 * Test 1: 两个 parallelizable 工具，结果按原始顺序注入
 */
async function testBasicParallel(): Promise<void> {
  const executedTools: string[] = [];
  const tools: Tool[] = [
    {
      name: 'read_a',
      description: 'Read file A',
      parallelizable: true,
      execute: async () => {
        executedTools.push('read_a');
        return 'content_a';
      },
    },
    {
      name: 'read_b',
      description: 'Read file B',
      parallelizable: true,
      execute: async () => {
        executedTools.push('read_b');
        return 'content_b';
      },
    },
  ];

  const agent = new ParallelTestAgent(new ParallelBatchLLM(), tools);
  await agent.onCall('Read two files');

  // 两个工具都应执行
  assert(executedTools.length === 2, 'both parallelizable tools should execute');
  assert(executedTools.includes('read_a'), 'read_a should execute');
  assert(executedTools.includes('read_b'), 'read_b should execute');

  // 结果按原始顺序注入（read_a 在 read_b 之前）
  const messages = agent.getContext().getAll();
  const toolMessages = messages.filter(m => m.role === 'tool');
  assert(toolMessages.length === 2, 'should have 2 tool results');
  assert(toolMessages[0].toolCallId === 'tc_1', 'first result should be read_a (tc_1)');
  assert(toolMessages[1].toolCallId === 'tc_2', 'second result should be read_b (tc_2)');
  assert(toolMessages[0].content.includes('content_a'), 'first result content correct');
  assert(toolMessages[1].content.includes('content_b'), 'second result content correct');

  console.log('[PASS] Basic parallel: two parallelizable tools, results in original order');
}

/**
 * Test 2: 混合批次 [parallel, serial, parallel]
 */
async function testMixedBatch(): Promise<void> {
  const executedTools: string[] = [];
  const tools: Tool[] = [
    {
      name: 'read_a',
      description: 'Read file A',
      parallelizable: true,
      execute: async () => {
        executedTools.push('read_a');
        return 'content_a';
      },
    },
    {
      name: 'write_c',
      description: 'Write file C',
      execute: async () => {
        executedTools.push('write_c');
        return 'written_c';
      },
    },
    {
      name: 'grep_d',
      description: 'Grep search',
      parallelizable: true,
      execute: async () => {
        executedTools.push('grep_d');
        return 'grep_result';
      },
    },
  ];

  const agent = new ParallelTestAgent(new MixedBatchLLM(), tools);
  await agent.onCall('Mixed batch');

  // 所有工具都应执行
  assert(executedTools.length === 3, 'all 3 tools should execute');
  assert(executedTools.includes('read_a'), 'read_a should execute');
  assert(executedTools.includes('write_c'), 'write_c should execute');
  assert(executedTools.includes('grep_d'), 'grep_d should execute');

  // 结果按原始顺序注入：read_a, write_c, grep_d
  const messages = agent.getContext().getAll();
  const toolMessages = messages.filter(m => m.role === 'tool');
  assert(toolMessages.length === 3, 'should have 3 tool results');
  assert(toolMessages[0].toolCallId === 'tc_1', 'result order: read_a first');
  assert(toolMessages[1].toolCallId === 'tc_2', 'result order: write_c second');
  assert(toolMessages[2].toolCallId === 'tc_3', 'result order: grep_d third');

  console.log('[PASS] Mixed batch: [parallel, serial, parallel] results in original order');
}

/**
 * Test 3: 全串行回退（无 parallelizable 工具）
 */
async function testAllSerialFallback(): Promise<void> {
  const executedTools: string[] = [];
  const tools: Tool[] = [
    {
      name: 'write_a',
      description: 'Write file A',
      execute: async () => {
        executedTools.push('write_a');
        return 'written_a';
      },
    },
    {
      name: 'write_b',
      description: 'Write file B',
      execute: async () => {
        executedTools.push('write_b');
        return 'written_b';
      },
    },
  ];

  const agent = new ParallelTestAgent(new AllSerialLLM(), tools);
  await agent.onCall('Two serial tools');

  // 两个工具都应执行
  assert(executedTools.length === 2, 'both tools should execute');
  assert(executedTools.includes('write_a'), 'write_a should execute');
  assert(executedTools.includes('write_b'), 'write_b should execute');

  // 结果按顺序注入
  const messages = agent.getContext().getAll();
  const toolMessages = messages.filter(m => m.role === 'tool');
  assert(toolMessages.length === 2, 'should have 2 tool results');
  assert(toolMessages[0].toolCallId === 'tc_1', 'result order: write_a first');
  assert(toolMessages[1].toolCallId === 'tc_2', 'result order: write_b second');

  console.log('[PASS] All-serial fallback: no parallelizable tools, behavior unchanged');
}

/**
 * Test 4: parallelizable 工具真正并发执行
 *
 * 两个工具各 sleep 200ms。如果串行，总时间 >= 400ms。
 * 如果并行，总时间 < 400ms（约 200ms）。
 */
async function testConcurrentTiming(): Promise<void> {
  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

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
      execute: async () => {
        await sleep(200);
        return 'slow_a';
      },
    },
    {
      name: 'slow_read_b',
      description: 'Slow read B',
      parallelizable: true,
      execute: async () => {
        await sleep(200);
        return 'slow_b';
      },
    },
  ];

  const agent = new ParallelTestAgent(new SlowParallelLLM(), tools);
  const startTime = Date.now();
  await agent.onCall('Read two slow files');
  const elapsed = Date.now() - startTime;

  // 并行执行：总时间应远小于 400ms（串行总和）
  // 留出充足余量（LLM mock + overhead）
  assert(elapsed < 380, `parallel execution should be faster than serial (elapsed: ${elapsed}ms, threshold: 380ms)`);

  console.log(`[PASS] Concurrent timing: two 200ms tools completed in ${elapsed}ms (< 380ms threshold)`);
}

/**
 * Test 5: exclusive + parallelizable 不冲突
 *
 * exclusive 工具仍然整批拒绝（>1 调用时），parallelizable 属性被忽略
 */
async function testExclusiveWithParallelizable(): Promise<void> {
  const executedTools: string[] = [];

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

  const tools: Tool[] = [
    {
      name: 'checkpoint',
      description: 'Checkpoint',
      executionMode: 'exclusive',
      execute: async () => {
        executedTools.push('checkpoint');
        return 'cp';
      },
    },
    {
      name: 'read_x',
      description: 'Read X',
      parallelizable: true,
      execute: async () => {
        executedTools.push('read_x');
        return 'content_x';
      },
    },
  ];

  const agent = new ParallelTestAgent(new ExclusiveMixedLLM(), tools);
  await agent.onCall('Exclusive + parallel');

  // exclusive 批次拒绝：两个工具都不应执行
  const messages = agent.getContext().getAll();
  const toolMessages = messages.filter(m => m.role === 'tool');
  const rejected = toolMessages.filter(m => m.content.includes('must be the only tool call'));
  assert(rejected.length === 2, 'both tools should be rejected in exclusive batch violation');

  console.log('[PASS] Exclusive + parallelizable: batch still rejected');
}

// ========== Main ==========

async function main(): Promise<void> {
  await testBasicParallel();
  await testMixedBatch();
  await testAllSerialFallback();
  await testConcurrentTiming();
  await testExclusiveWithParallelizable();

  console.log('\nAll parallel tool execution tests passed.');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
