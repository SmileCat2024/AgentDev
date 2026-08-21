import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';
import { TodoFeature } from '../src/features/todo/index.js';
import { OpencodeBasicFeature } from '../src/features/opencode-basic/index.js';
import { SubAgentFeature } from '../src/features/subagent/index.js';
import { createStepCheckpoint, restoreFeatureSnapshots } from '../src/core/checkpoint.js';
import { Context } from '../src/core/context.js';

class NoopLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'ok' };
  }
}

class DummyAgent extends Agent {
  constructor() {
    super({
      llm: new NoopLLM(),
      maxTurns: 1,
      name: 'DummyAgent',
      systemMessage: 'dummy',
    });
  }
}

describe('Feature rollback compatibility', () => {
  it('should restore TodoFeature snapshot after mutations', async () => {
    const feature = new TodoFeature();
    const features = new Map<string, any>([['todo', feature]]);
    feature.createTask('修复 bug', '需要修复 rollback', '正在修复 rollback');
    const checkpoint = createStepCheckpoint(new Context(), features);

    feature.updateTask('1', { status: 'completed' });
    feature.setReminderContent('mutated reminder');
    feature.clearTasks();
    await restoreFeatureSnapshots(checkpoint.features, features);

    expect(feature.getTask('1')?.status).toBe('pending');
    expect(feature.listTasks()).toHaveLength(1);
  });

  it('should restore OpencodeBasicFeature read history', async () => {
    const feature = new OpencodeBasicFeature();
    await feature.onInitiate({} as any);

    await feature.validateWriteOperation({
      call: {
        id: 'read_1',
        name: 'read',
        arguments: { filePath: 'README.md' },
      },
      context: new DummyAgent().getContext(),
    } as any);

    const snapshot = feature.captureState();
    feature.restoreState({ readFiles: [] });
    feature.restoreState(snapshot);

    const decision = await feature.validateWriteOperation({
      call: {
        id: 'write_1',
        name: 'write',
        arguments: { filePath: 'README.md' },
      },
      context: new DummyAgent().getContext(),
    } as any);

    expect((decision as any).action).not.toBe('deny');
  });

  it('should degrade SubAgentFeature restore cleanly', async () => {
    const parent = new DummyAgent();
    const feature = new SubAgentFeature();
    feature._setParentAgent(parent);

    const pool = feature.pool!;
    await pool.spawn('BasicAgent', async () => new DummyAgent());

    const snapshot = feature.captureState() as any;
    expect(snapshot.hadInstances).toBe(true);

    await feature.restoreState(snapshot);

    expect(feature.pool?.list()).toHaveLength(0);
  });
});
