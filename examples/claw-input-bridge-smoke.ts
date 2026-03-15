import { DebugHub } from '../src/index.js';

async function main(): Promise<void> {
  const debugHub = DebugHub.getInstance();
  await debugHub.start(2026, false);

  const agent = {
    constructor: {
      name: 'ClawInputBridgeAgent',
    },
  };

  const agentId = debugHub.registerAgent(agent, 'ClawInputBridgeAgent');
  const response = await debugHub.requestUserInputEvent(agentId, {
    prompt: '请输入 bridge test',
    placeholder: 'type here',
  }, 10000);

  console.log(`input-response=${response.kind}:${response.text ?? response.actionId ?? ''}`);
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
