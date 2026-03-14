import { Agent } from '../core/agent.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool, ToolCall } from '../core/types.js';
import type { ToolResult } from '../core/lifecycle.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class RollbackLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const hasAssistant = messages.some(message => message.role === 'assistant');
    if (hasAssistant) {
      return { content: 'unexpected second step' };
    }

    return {
      content: '准备执行状态变更工具。',
      toolCalls: [
        {
          id: 'tool_rollback_1',
          name: 'mutate_state',
          arguments: {},
        },
      ],
    };
  }
}

class RollbackFeature implements AgentFeature {
  readonly name = 'rollback-feature';
  counter = 0;
  beforeRollbackCount = 0;
  afterRollbackCount = 0;

  getTools(): Tool[] {
    return [
      {
        name: 'mutate_state',
        description: 'Mutates feature state for rollback testing',
        execute: async () => {
          this.counter += 1;
          return 'counter incremented';
        },
      },
    ];
  }

  captureState(): { counter: number; beforeRollbackCount: number; afterRollbackCount: number } {
    return {
      counter: this.counter,
      beforeRollbackCount: this.beforeRollbackCount,
      afterRollbackCount: this.afterRollbackCount,
    };
  }

  restoreState(snapshot: { counter: number; beforeRollbackCount: number; afterRollbackCount: number }): void {
    this.counter = snapshot.counter;
    this.beforeRollbackCount = snapshot.beforeRollbackCount;
    this.afterRollbackCount = snapshot.afterRollbackCount;
  }

  beforeRollback(): void {
    this.beforeRollbackCount += 1;
  }

  afterRollback(): void {
    this.afterRollbackCount += 1;
  }
}

class RollbackAgent extends Agent {
  constructor(private readonly rollbackFeature: RollbackFeature) {
    super({
      llm: new RollbackLLM(),
      maxTurns: 3,
      name: 'RollbackAgent',
    });
    this.use(rollbackFeature);
  }

  getFeatureState(): RollbackFeature {
    return this.rollbackFeature;
  }

  protected override async onToolFinished(result: ToolResult): Promise<void> {
    if (result.call.name === 'mutate_state') {
      throw new Error('forced failure after tool execution');
    }
  }
}

async function testStepCheckpointRollback(): Promise<void> {
  const feature = new RollbackFeature();
  const agent = new RollbackAgent(feature);

  let errorMessage = '';
  try {
    await agent.onCall('请测试 step rollback');
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  assert(errorMessage.includes('forced failure after tool execution'), 'agent should surface the forced failure');
  assert(feature.counter === 0, 'feature state should be restored after rollback');
  assert(feature.beforeRollbackCount === 0, 'beforeRollback state mutations should not leak after restore');
  assert(feature.afterRollbackCount === 1, 'afterRollback should run after restore');

  const messages = agent.getContext().getAll();
  assert(messages.length === 1, 'rollback should remove assistant and tool messages created inside the failed step');
  assert(messages[0]?.role === 'user', 'the pre-step user message should be preserved');

  const query = agent.getContext().query();
  assert(query.byRole('user').count() === 1, 'context query should remain usable after rollback restore');
  assert(agent.getContext().query().byRole('assistant').count() === 0, 'no assistant message should remain after rollback');
}

await testStepCheckpointRollback();
console.log('Rollback checkpoint tests passed');
