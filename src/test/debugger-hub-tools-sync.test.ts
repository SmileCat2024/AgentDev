import { createTool } from '../core/tool.js';
import { Agent } from '../core/agent.js';
import type { AgentFeature } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';
import { DebugHub } from '../core/debug-hub.js';
import { ViewerWorker } from '../core/viewer-worker.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-viewer-tools-sync-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-viewer-tools-sync-${process.pid}-${Date.now()}.sock`;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

class NoopLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'ok' };
  }
}

class ToggleFeature implements AgentFeature {
  readonly name = 'toggle';

  getTools(): Tool[] {
    return [
      createTool({
        name: 'toggle_tool',
        description: 'A tool that can be enabled or disabled.',
        async execute() {
          return 'ok';
        },
      }),
    ];
  }
}

class TestAgent extends Agent {}

class InitiateDisableAgent extends Agent {
  protected override async onInitiate(): Promise<void> {
    this.getTools().disable('toggle_tool');
  }
}

async function main(): Promise<void> {
  const originalUdsPath = process.env.AGENTDEV_UDS_PATH;
  const udsPath = getTestUdsPath();
  process.env.AGENTDEV_UDS_PATH = udsPath;

  const worker = new ViewerWorker(0, false, udsPath);
  await worker.start();

  try {
    const agent = new TestAgent({
      llm: new NoopLLM(),
      name: 'ToolsSyncAgent',
    }).use(new ToggleFeature());

    await agent.withViewer('ToolsSyncAgent', 0, false);

    const agentId = (agent as any).agentId as string | undefined;
    assert(agentId, 'agent should be registered in debugger');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(agentId);
      return !!session && session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool');
    });

    agent.disable('toggle');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(agentId);
      return !!session
        && !session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool')
        && session.hookInspector?.features?.some((feature: { name: string; enabledToolCount: number; status?: string }) =>
          feature.name === 'toggle' && feature.enabledToolCount === 0 && feature.status === 'disabled'
        );
    });

    console.log('[PASS] debugger hub tool registry stays in sync after feature disable');

    await agent.dispose();

    const preDisabledAgent = new TestAgent({
      llm: new NoopLLM(),
      name: 'PreDisabledAgent',
    }).use(new ToggleFeature());

    preDisabledAgent.getTools().disable('toggle_tool');

    await preDisabledAgent.withViewer('PreDisabledAgent', 0, false);

    const preDisabledAgentId = (preDisabledAgent as any).agentId as string | undefined;
    assert(preDisabledAgentId, 'pre-disabled agent should be registered in debugger');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(preDisabledAgentId);
      return !!session
        && !session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool')
        && session.hookInspector?.features?.some((feature: { name: string; enabledToolCount: number; status?: string }) =>
          feature.name === 'toggle' && feature.enabledToolCount === 0 && feature.status === 'disabled'
        );
    });

    console.log('[PASS] debugger snapshot reflects pre-disabled tools before the first call');
    await preDisabledAgent.dispose();

    const initiateAgent = new InitiateDisableAgent({
      llm: new NoopLLM(),
      name: 'InitiateDisableAgent',
    }).use(new ToggleFeature());

    await initiateAgent.withViewer('InitiateDisableAgent', 0, false);

    const initiateAgentId = (initiateAgent as any).agentId as string | undefined;
    assert(initiateAgentId, 'initiate-disable agent should be registered in debugger');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(initiateAgentId);
      return !!session && session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool');
    });

    await initiateAgent.onCall('hello');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(initiateAgentId);
      return !!session && !session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool');
    });

    console.log('[PASS] debugger hub tool registry stays in sync after onInitiate disables tools');
    await initiateAgent.dispose();
  } finally {
    DebugHub.getInstance().stop();
    await worker.stop();

    if (originalUdsPath === undefined) {
      delete process.env.AGENTDEV_UDS_PATH;
    } else {
      process.env.AGENTDEV_UDS_PATH = originalUdsPath;
    }
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
