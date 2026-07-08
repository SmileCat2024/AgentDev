import { describe, it, expect } from 'vitest';
import { createTool, ToolRegistry } from '../core/tool.js';

describe('ToolRegistry pre-disable', () => {
  it('should pre-disable a tool before registration and preserve state', () => {
    const registry = new ToolRegistry();

    expect(registry.disable('future_tool')).toBe(true);

    registry.register(createTool({
      name: 'future_tool',
      description: 'Tool registered after disable.',
      async execute() {
        return 'ok';
      },
    }));

    expect(registry.has('future_tool')).toBe(true);
    expect(registry.isEnabled('future_tool')).toBe(false);
    expect(registry.isDisabled('future_tool')).toBe(true);
    expect(registry.getAll().some(tool => tool.name === 'future_tool')).toBe(true);
  });

  it('should support remove and re-enable after pre-disable', () => {
    const registry = new ToolRegistry();
    registry.disable('future_tool');
    registry.register(createTool({
      name: 'future_tool',
      description: 'Tool registered after disable.',
      async execute() {
        return 'ok';
      },
    }));

    expect(registry.remove('future_tool')).toBe(true);
    expect(registry.isRemoved('future_tool')).toBe(true);
    expect(registry.getAll().some(tool => tool.name === 'future_tool')).toBe(false);

    expect(registry.enable('future_tool')).toBe(true);
    expect(registry.isEnabled('future_tool')).toBe(true);
    expect(registry.getAll().some(tool => tool.name === 'future_tool')).toBe(true);
  });
});
