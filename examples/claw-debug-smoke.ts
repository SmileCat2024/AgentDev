import { DebugHub, createTool } from '../src/index.js';

async function main(): Promise<void> {
  console.log(`[Smoke] Requested transport: ${process.env.AGENTDEV_DEBUG_TRANSPORT ?? 'viewer-worker(default)'}`);
  console.log(`[Smoke] Claw runtime URL: ${process.env.AGENTDEV_CLAW_RUNTIME_URL ?? '(not set)'}`);

  const debugHub = DebugHub.getInstance();
  await debugHub.start(2026, false);

  const agent = {
    constructor: {
      name: 'ClawSmokeAgent',
    },
  };

  const agentId = debugHub.registerAgent(agent, 'ClawSmokeAgent', {}, {
    lifecycleOrder: ['onCall'],
    features: [],
    hooks: [],
  }, {
    updatedAt: Date.now(),
    context: {
      messageCount: 2,
      charCount: 48,
      toolCallCount: 1,
      turnCount: 1,
    },
    usageStats: {} as any,
  });

  debugHub.registerAgentTools(agentId, [
    createTool({
      name: 'echo',
      description: 'Echo demo tool',
      execute: async (args: any) => args,
    }),
  ]);

  debugHub.pushMessages(agentId, [
    { role: 'user', content: 'hello claw runtime' },
    { role: 'assistant', content: 'debug transport bridge is working' },
  ]);

  debugHub.pushNotification(agentId, {
    type: 'smoke-state',
    category: 'state',
    timestamp: Date.now(),
    data: {
      status: 'ok',
    },
  });

  debugHub.pushNotification(agentId, {
    type: 'log.entry',
    category: 'event',
    timestamp: Date.now(),
    data: {
      id: `smoke-log-${Date.now()}`,
      timestamp: Date.now(),
      level: 'info',
      message: 'claw smoke log entry',
      namespace: 'agentdev.smoke',
      context: {
        agentId,
        agentName: 'ClawSmokeAgent',
      },
      delivery: {
        hub: true,
        console: false,
        reason: 'hub',
      },
    },
  });

  console.log(`[Smoke] Registered agent ${agentId} via transport ${process.env.AGENTDEV_DEBUG_TRANSPORT ?? 'viewer-worker'}`);
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
