import { createTool, ToolRegistry } from '../core/tool.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const registry = new ToolRegistry();

  assert(registry.disable('future_tool') === true, 'pre-disable should succeed even before registration');

  registry.register(createTool({
    name: 'future_tool',
    description: 'Tool registered after disable.',
    async execute() {
      return 'ok';
    },
  }));

  assert(registry.has('future_tool'), 'tool should be registered');
  assert(!registry.isEnabled('future_tool'), 'pre-disabled tool should stay disabled after registration');
  assert(registry.isDisabled('future_tool'), 'pre-disabled tool should be in disabled state after registration');
  assert(registry.getAll().some(tool => tool.name === 'future_tool'), 'disabled tool should still appear in LLM-visible tool list');

  assert(registry.remove('future_tool') === true, 'remove should work after registration');
  assert(registry.isRemoved('future_tool'), 'tool should become removed after remove');
  assert(!registry.getAll().some(tool => tool.name === 'future_tool'), 'removed tool should not appear in LLM-visible tool list');

  assert(registry.enable('future_tool') === true, 'enable should work after registration');
  assert(registry.isEnabled('future_tool'), 'tool should become enabled after enable');
  assert(registry.getAll().some(tool => tool.name === 'future_tool'), 'enabled tool should reappear in enabled tool list');

  console.log('[PASS] ToolRegistry preserves pre-disable state across later registration');
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
