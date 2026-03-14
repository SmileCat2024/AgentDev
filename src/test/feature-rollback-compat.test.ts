import { Agent } from '../core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';
import { TodoFeature } from '../features/todo/index.js';
import { OpencodeBasicFeature } from '../features/opencode-basic/index.js';
import { VisualFeature } from '../features/visual/index.js';
import { SubAgentFeature } from '../features/subagent/index.js';
import { createStepCheckpoint, restoreFeatureSnapshots } from '../core/checkpoint.js';
import { Context } from '../core/context.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

async function testTodoFeatureSnapshot(): Promise<void> {
  const feature = new TodoFeature();
  const features = new Map<string, any>([['todo', feature]]);
  feature.createTask('修复 bug', '需要修复 rollback', '正在修复 rollback');
  const checkpoint = createStepCheckpoint(new Context(), features);

  feature.updateTask('1', { status: 'completed' });
  feature.setReminderContent('mutated reminder');
  feature.clearTasks();
  await restoreFeatureSnapshots(checkpoint.features, features);

  assert(feature.getTask('1')?.status === 'pending', 'todo task status should be restored from snapshot, not later mutation');
  assert(feature.listTasks().length === 1, 'todo tasks should be restored');
}

async function testOpencodeBasicSnapshot(): Promise<void> {
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

  assert((decision as any).action !== 'deny', 'opencode-basic read history should be restored');
}

async function testVisualFeatureSnapshot(): Promise<void> {
  const feature = new VisualFeature({
    monitoring: { enabled: false },
    checkPythonEnv: false,
  });

  feature.restoreState({
    visualEnabled: true,
    injectionState: {
      isFirstInjection: false,
      lastInjectedWindows: [[
        'hwnd-1',
        {
          title: 'Editor',
          status: 'Normal',
          processPath: 'C:/editor.exe',
          isForeground: true,
        },
      ]],
      lastInjectedAnalyses: [['hwnd-1', 'hash-1']],
      focusHistory: ['hwnd-1'],
      lastForegroundHwnd: 'hwnd-1',
    },
  });

  const snapshot = feature.captureState() as any;
  assert(snapshot.visualEnabled === true, 'visual enabled state should be captured');
  assert(snapshot.injectionState.lastInjectedWindows.length === 1, 'visual window history should be captured');
  assert(snapshot.injectionState.lastInjectedAnalyses.length === 1, 'visual analysis history should be captured');
}

async function testSubAgentRestoreDegradesCleanly(): Promise<void> {
  const parent = new DummyAgent();
  const feature = new SubAgentFeature();
  feature._setParentAgent(parent);

  const pool = feature.pool!;
  await pool.spawn('BasicAgent', async () => new DummyAgent());

  const snapshot = feature.captureState() as any;
  assert(snapshot.hadInstances === true, 'subagent snapshot should record existing runtime');

  await feature.restoreState(snapshot);

  assert(feature.pool?.list().length === 0, 'subagent restore should clear live runtime instances');
}

await testTodoFeatureSnapshot();
await testOpencodeBasicSnapshot();
await testVisualFeatureSnapshot();
await testSubAgentRestoreDegradesCleanly();

console.log('Feature rollback compatibility tests passed');
