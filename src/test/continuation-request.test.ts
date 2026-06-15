/**
 * Continuation Request 测试
 *
 * 验证：
 * 1. 控制工具执行后通过 context.registerContinuationRequest 登记请求
 * 2. ReAct 循环在工具结果闭合后停止，不再请求 LLM
 * 3. onCall 正常返回（不抛异常）
 * 4. consumeContinuationRequest 返回请求
 * 5. 重复消费返回 null（一次性消费）
 * 6. 下一次 onCall 自动清理上次遗留的请求
 * 7. 普通 onCall（无 continuation）行为不变
 */

import { Agent } from '../core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';
import type { CallContinuationRequest } from '../core/continuation.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// ========== Mock LLM ==========

class CheckpointLLM implements LLMClient {
  chatCount = 0;

  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.chatCount++;
    const hasToolResults = messages.some(m => m.role === 'tool');

    if (!hasToolResults) {
      // Step 0: 调用 checkpoint 工具
      return {
        content: 'Creating a checkpoint.',
        toolCalls: [
          { id: 'tc_cp', name: 'checkpoint', arguments: { checkpointId: 'cp-test' } },
        ],
      };
    }

    // 不应该执行到这里（continuation request 应让循环停止）
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

async function testCheckpointContinuation(): Promise<void> {
  const llm = new CheckpointLLM();
  let registerCalled = false;

  const tools: Tool[] = [
    {
      name: 'checkpoint',
      description: 'Create a checkpoint',
      executionMode: 'exclusive',
      execute: async (args: any, context?: any) => {
        // 通过注入的 registerContinuationRequest 登记 continuation
        assert(typeof context?.registerContinuationRequest === 'function',
          'registerContinuationRequest should be injected into tool context');
        context.registerContinuationRequest({
          kind: 'checkpoint',
          checkpointId: args.checkpointId,
        });
        registerCalled = true;
        return `Checkpoint "${args.checkpointId}" has been established.`;
      },
    },
  ];

  const agent = new (class extends Agent {
    constructor() {
      super({ llm, maxTurns: 5, name: 'CheckpointAgent', tools });
    }
  })();

  const response = await agent.onCall('Do something with checkpoint');

  // 验证：工具执行了 registerContinuationRequest
  assert(registerCalled, 'registerContinuationRequest should have been called');

  // 验证：LLM 只被调用了一次（工具结果闭合后循环停止）
  assert(llm.chatCount === 1, `LLM should be called exactly once, got ${llm.chatCount}`);

  // 验证：onCall 正常返回
  assert(typeof response === 'string', 'onCall should return a string');

  // 验证：consumeContinuationRequest 返回请求
  const request = agent.consumeContinuationRequest();
  assert(request !== null, 'continuation request should be available');
  assert(request!.kind === 'checkpoint', 'request kind should be checkpoint');
  assert((request as any).checkpointId === 'cp-test', 'checkpointId should match');

  // 验证：重复消费返回 null
  const secondConsume = agent.consumeContinuationRequest();
  assert(secondConsume === null, 'second consume should return null');

  console.log('[PASS] Checkpoint continuation: registered, LLM stopped, consumed once');
}

async function testRollbackContinuation(): Promise<void> {
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
  assert(request !== null, 'rollback continuation request should be available');
  assert(request!.kind === 'rollback', 'request kind should be rollback');
  assert((request as any).checkpointId === 'cp-test', 'checkpointId should match');
  assert((request as any).summary === 'tried A, failed because B', 'summary should match');

  console.log('[PASS] Rollback continuation: registered with summary, consumed');
}

async function testStaleRequestCleared(): Promise<void> {
  // 测试：onCall 开始时自动清理上次遗留的 continuation request
  const checkpointLLM = new CheckpointLLM();
  const normalLLM = new NormalCompletionLLM();

  const tools: Tool[] = [
    {
      name: 'checkpoint',
      description: 'Create a checkpoint',
      executionMode: 'exclusive',
      execute: async (args: any, context?: any) => {
        context?.registerContinuationRequest({
          kind: 'checkpoint',
          checkpointId: args.checkpointId,
        });
        return 'Checkpoint created.';
      },
    },
  ];

  // Agent 1: 注册 continuation 但不消费（模拟宿主忘记消费）
  const agent1 = new (class extends Agent {
    constructor() {
      super({ llm: checkpointLLM, maxTurns: 5, name: 'StaleAgent', tools });
    }
  })();

  await agent1.onCall('First call with checkpoint');
  // 不消费！留一个 stale request

  // Agent 2: 普通调用（无 continuation），不应看到 agent1 的 request
  const agent2 = new (class extends Agent {
    constructor() {
      super({ llm: normalLLM, maxTurns: 5, name: 'NormalAgent' });
    }
  })();

  await agent2.onCall('Normal call');
  assert(agent2.consumeContinuationRequest() === null, 'normal call should not have continuation');

  // Agent 3: 使用 checkpoint LLM，第一次 onCall 注册 continuation
  // 然后第二次 onCall（用不同 LLM）应清理掉旧的
  const checkpointLLM2 = new CheckpointLLM();
  const agent3 = new (class extends Agent {
    private llmIdx = 0;
    constructor() {
      super({ llm: checkpointLLM2, maxTurns: 5, name: 'StaleAgent3', tools });
    }
  })();

  await agent3.onCall('Register checkpoint');
  // 不消费！现在 _continuationRequest 有值

  // 第二次 onCall 开始时会清理旧的 _continuationRequest
  // 但 checkpointLLM2 已经被调用过一次，第二次调用时消息中已有 tool result，
  // 所以不会再次调用 checkpoint 工具。用 NormalCompletionLLM 替换。
  (agent3 as any).llm = normalLLM;
  await agent3.onCall('Normal follow-up');
  assert(agent3.consumeContinuationRequest() === null,
    'second onCall should clear stale continuation and not register new one');

  console.log('[PASS] Stale request handling: cleared at onCall start');
}

async function testDoubleRegisterThrows(): Promise<void> {
  const llm = new CheckpointLLM();

  const tools: Tool[] = [
    {
      name: 'checkpoint',
      description: 'Create a checkpoint',
      executionMode: 'exclusive',
      execute: async (args: any, context?: any) => {
        // 第一次注册
        context?.registerContinuationRequest({
          kind: 'checkpoint',
          checkpointId: 'cp-1',
        });
        // 第二次注册应该抛异常
        try {
          context?.registerContinuationRequest({
            kind: 'checkpoint',
            checkpointId: 'cp-2',
          });
          throw new Error('should have thrown on double registration');
        } catch (e) {
          assert(
            (e as Error).message.includes('already registered'),
            'should throw "already registered" error'
          );
        }
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
  assert(request !== null, 'first registration should succeed');
  assert((request as any).checkpointId === 'cp-1', 'should retain first request');

  console.log('[PASS] Double register: throws, first request retained');
}

async function main(): Promise<void> {
  await testCheckpointContinuation();
  await testRollbackContinuation();
  await testStaleRequestCleared();
  await testDoubleRegisterThrows();

  console.log('\nAll continuation request tests passed.');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
