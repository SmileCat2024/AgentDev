import { describe, it, expect } from 'vitest';
import { Agent } from '../core/agent.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';
import type { ToolResult } from '../core/lifecycle.js';

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

describe('Step checkpoint rollback', () => {
  it('should restore feature state and surface the error after tool failure', async () => {
    const feature = new RollbackFeature();
    const agent = new RollbackAgent(feature);

    const result = await agent.onCall('请测试 step rollback');

    expect(result).toContain('forced failure after tool execution');
    expect(feature.counter).toBe(0);
    expect(feature.beforeRollbackCount).toBe(0);
    expect(feature.afterRollbackCount).toBe(1);

    const messages = agent.getContext().getAll();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toContain('forced failure after tool execution');

    const query = agent.getContext().query();
    expect(query.byRole('user').count()).toBe(1);
    expect(agent.getContext().query().byRole('assistant').count()).toBe(1);
  });
});
