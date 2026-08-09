import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createTool } from '../core/tool.js';
import { Agent } from '../core/agent.js';
import type { AgentFeature, FeatureInitContext } from '../core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';
import { DebugHub } from '../core/debug-hub.js';
import { ViewerWorker } from '../core/viewer-worker.js';
import { UserInputFeature } from '../features/user-input/index.js';

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

class BrokenFeature implements AgentFeature {
  readonly name = 'broken';

  getTools(): Tool[] {
    throw new Error('broken feature preparation');
  }
}

class IdentityCaptureFeature implements AgentFeature {
  readonly name = 'identity-capture';
  initiatedAgentId: string | undefined;

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.initiatedAgentId = ctx.agentId;
  }
}

class TestAgent extends Agent {}

class InitiateDisableAgent extends Agent {
  protected override async onInitiate(): Promise<void> {
    this.getTools().disable('toggle_tool');
  }
}

describe('Debugger hub tools sync', () => {
  let worker: ViewerWorker;
  let originalUdsPath: string | undefined;
  const udsPath = getTestUdsPath();

  beforeAll(() => {
    originalUdsPath = process.env.AGENTDEV_UDS_PATH;
    process.env.AGENTDEV_UDS_PATH = udsPath;
  });

  afterAll(async () => {
    DebugHub.getInstance().stop();
    await worker.stop();

    if (originalUdsPath === undefined) {
      delete process.env.AGENTDEV_UDS_PATH;
    } else {
      process.env.AGENTDEV_UDS_PATH = originalUdsPath;
    }
  });

  it('should sync tool registry after feature disable', async () => {
    worker = new ViewerWorker(0, false, udsPath);
    await worker.start();

    const agent = new TestAgent({
      llm: new NoopLLM(),
      name: 'ToolsSyncAgent',
    }).use(new ToggleFeature());

    await agent.withViewer('ToolsSyncAgent', 0, false);

    const agentId = (agent as any).agentId as string;
    expect(agentId).toBeDefined();

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(agentId);
      return !!session && session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool');
    });

    agent.disable('toggle');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(agentId);
      return !!session
        && session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool')
        && session.hookInspector?.features?.some((feature: { name: string; enabledToolCount: number; status?: string; tools?: Array<{ name: string; state?: string }> }) =>
          feature.name === 'toggle'
          && feature.enabledToolCount === 0
          && feature.status === 'disabled'
          && feature.tools?.some(tool => tool.name === 'toggle_tool' && tool.state === 'disabled')
        );
    });

    await agent.dispose();
  });

  it('should register the viewer identity before feature initialization', async () => {
    const identityFeature = new IdentityCaptureFeature();
    const identityAgent = new TestAgent({
      llm: new NoopLLM(),
      name: 'IdentityInitAgent',
    }).use(identityFeature);

    const registeredAgentId = (identityAgent as any).agentId as string;
    expect(registeredAgentId).toBeDefined();

    // Feature preparation is also reachable before Viewer attachment through
    // snapshot/session APIs. It must receive the same stable runtime identity.
    await identityAgent.createSessionSnapshot('before-viewer');
    expect(identityFeature.initiatedAgentId).toBe(registeredAgentId);

    await identityAgent.withViewer('IdentityInitAgent', 0, false);
    expect((identityAgent as any).agentId).toBe(registeredAgentId);

    await identityAgent.dispose();
  });

  it('should roll back Viewer registration when feature preparation fails', async () => {
    const brokenAgent = new TestAgent({
      llm: new NoopLLM(),
      name: 'BrokenAttachAgent',
    }).use(new BrokenFeature());
    const runtimeId = (brokenAgent as any).agentId as string;

    await expect(brokenAgent.withViewer('BrokenAttachAgent', 0, false))
      .rejects.toThrow('broken feature preparation');

    expect(DebugHub.getInstance().getAgentList().some(info => info.id === runtimeId)).toBe(false);
    expect((brokenAgent as any).debugEnabled).toBe(false);
    await brokenAgent.dispose();
  });

  it('should isolate concurrent user input requests for two live Agents', async () => {
    const inputA = new UserInputFeature();
    const inputB = new UserInputFeature();
    const agentA = new TestAgent({ llm: new NoopLLM(), name: 'InputAgentA' }).use(inputA);
    const agentB = new TestAgent({ llm: new NoopLLM(), name: 'InputAgentB' }).use(inputB);

    await agentA.withViewer('InputAgentA', 0, false);
    await agentB.withViewer('InputAgentB', 0, false);

    const agentAId = (agentA as any).agentId as string;
    const agentBId = (agentB as any).agentId as string;
    expect(agentAId).not.toBe(agentBId);

    const pendingA = inputA.getUserInputEvent('input A');
    const pendingB = inputB.getUserInputEvent('input B');

    await waitFor(() => {
      const requestsA = (worker as any).agentSessions.get(agentAId)?.pendingInputRequests;
      const requestsB = (worker as any).agentSessions.get(agentBId)?.pendingInputRequests;
      return requestsA?.size === 1 && requestsB?.size === 1;
    });

    expect(worker.submitUserTurn(agentAId, { text: 'answer A' }).success).toBe(true);
    expect(worker.submitUserTurn(agentBId, { text: 'answer B' }).success).toBe(true);

    await expect(pendingA).resolves.toMatchObject({ kind: 'text', text: 'answer A' });
    await expect(pendingB).resolves.toMatchObject({ kind: 'text', text: 'answer B' });

    await agentA.dispose();
    await agentB.dispose();
  });

  it('should reflect pre-disabled tools before the first call', async () => {
    const preDisabledAgent = new TestAgent({
      llm: new NoopLLM(),
      name: 'PreDisabledAgent',
    }).use(new ToggleFeature());

    preDisabledAgent.getTools().disable('toggle_tool');

    await preDisabledAgent.withViewer('PreDisabledAgent', 0, false);

    const preDisabledAgentId = (preDisabledAgent as any).agentId as string;
    expect(preDisabledAgentId).toBeDefined();

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(preDisabledAgentId);
      return !!session
        && session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool')
        && session.hookInspector?.features?.some((feature: { name: string; enabledToolCount: number; status?: string; tools?: Array<{ name: string; state?: string }> }) =>
          feature.name === 'toggle'
          && feature.enabledToolCount === 0
          && feature.status === 'disabled'
          && feature.tools?.some(tool => tool.name === 'toggle_tool' && tool.state === 'disabled')
        );
    });

    await preDisabledAgent.dispose();
  });

  it('should sync tool registry after onInitiate disables tools', async () => {
    const initiateAgent = new InitiateDisableAgent({
      llm: new NoopLLM(),
      name: 'InitiateDisableAgent',
    }).use(new ToggleFeature());

    await initiateAgent.withViewer('InitiateDisableAgent', 0, false);

    const initiateAgentId = (initiateAgent as any).agentId as string;
    expect(initiateAgentId).toBeDefined();

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(initiateAgentId);
      return !!session && session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool');
    });

    await initiateAgent.onCall('hello');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(initiateAgentId);
      return !!session
        && session.tools.some((tool: { name: string }) => tool.name === 'toggle_tool')
        && session.hookInspector?.features?.some((feature: { name: string; enabledToolCount: number; status?: string; tools?: Array<{ name: string; state?: string }> }) =>
          feature.name === 'toggle'
          && feature.enabledToolCount === 0
          && feature.status === 'disabled'
          && feature.tools?.some(tool => tool.name === 'toggle_tool' && tool.state === 'disabled')
        );
    });

    await initiateAgent.dispose();
  });
});
