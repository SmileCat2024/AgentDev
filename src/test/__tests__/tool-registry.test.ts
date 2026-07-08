import { describe, it, expect } from 'vitest';
import { createTool, ToolRegistry } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';

/** Helper: create a minimal tool */
function makeTool(name: string, opts?: Partial<Tool>): Tool {
  return {
    name,
    description: `Tool: ${name}`,
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
    ...opts,
  };
}

describe('createTool', () => {
  it('should create a tool with required fields', () => {
    const tool = createTool({
      name: 'test',
      description: 'A test tool',
      execute: async () => 'ok',
    });
    expect(tool.name).toBe('test');
    expect(tool.description).toBe('A test tool');
    expect(tool.execute).toBeDefined();
    expect(tool.render).toBeUndefined();
  });

  it('should convert string render to { call, result } config', () => {
    const tool = createTool({
      name: 'test',
      description: 'test',
      execute: async () => 'ok',
      render: 'my-template',
    });
    expect(tool.render).toEqual({ call: 'my-template', result: 'my-template' });
  });

  it('should pass through object render config', () => {
    const render = { call: 'call-tmpl', result: 'result-tmpl' };
    const tool = createTool({
      name: 'test',
      description: 'test',
      execute: async () => 'ok',
      render,
    });
    expect(tool.render).toBe(render);
  });

  it('should set executionMode when provided', () => {
    const tool = createTool({
      name: 'test',
      description: 'test',
      execute: async () => 'ok',
      executionMode: 'exclusive',
    });
    expect(tool.executionMode).toBe('exclusive');
  });

  it('should not set executionMode when not provided', () => {
    const tool = createTool({
      name: 'test',
      description: 'test',
      execute: async () => 'ok',
    });
    expect(tool.executionMode).toBeUndefined();
  });

  it('should set parallelizable when provided', () => {
    const tool = createTool({
      name: 'test',
      description: 'test',
      execute: async () => 'ok',
      parallelizable: true,
    });
    expect(tool.parallelizable).toBe(true);
  });

  it('should auto-detect render path from sourceFile', () => {
    const tool = createTool(
      {
        name: 'test',
        description: 'test',
        execute: async () => 'ok',
      },
      '/path/to/tools/fs.ts',
    );
    expect((tool.render as any).__renderPath).toBe('/path/to/tools/fs.render.ts');
  });
});

describe('ToolRegistry', () => {
  // ========== Basic register/get ==========

  describe('register & get', () => {
    it('should register and retrieve a tool', () => {
      const reg = new ToolRegistry();
      const tool = makeTool('foo');
      reg.register(tool);
      expect(reg.get('foo')).toBe(tool);
      expect(reg.has('foo')).toBe(true);
    });

    it('should record source', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'), 'MyFeature');
      expect(reg.getSource('foo')).toBe('MyFeature');
    });

    it('should register without source', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'));
      expect(reg.getSource('foo')).toBeUndefined();
    });
  });

  // ========== Enable/disable/remove ==========

  describe('enable / disable', () => {
    it('should enable by default on register', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'));
      expect(reg.isEnabled('foo')).toBe(true);
      expect(reg.isDisabled('foo')).toBe(false);
    });

    it('should disable an enabled tool', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'));
      reg.disable('foo');
      expect(reg.isEnabled('foo')).toBe(false);
      expect(reg.isDisabled('foo')).toBe(true);
    });

    it('should re-enable a disabled tool', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'));
      reg.disable('foo');
      reg.enable('foo');
      expect(reg.isEnabled('foo')).toBe(true);
    });
  });

  describe('remove / unremove', () => {
    it('should remove a tool', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'));
      reg.remove('foo');
      expect(reg.isRemoved('foo')).toBe(true);
      expect(reg.isEnabled('foo')).toBe(false);
    });

    it('should not include removed tool in getAll', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'));
      reg.register(makeTool('bar'));
      reg.remove('foo');
      const all = reg.getAll();
      expect(all.map(t => t.name)).toEqual(['bar']);
    });

    it('should unremove a removed tool', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'));
      reg.remove('foo');
      reg.unremove('foo');
      expect(reg.isEnabled('foo')).toBe(true);
      expect(reg.isRemoved('foo')).toBe(false);
    });
  });

  // ========== Pre-registration disable ==========

  describe('pre-registration disable', () => {
    it('should respect pending disable before tool is registered', () => {
      const reg = new ToolRegistry();
      reg.disable('notYetRegistered');
      reg.register(makeTool('notYetRegistered'));
      expect(reg.isDisabled('notYetRegistered')).toBe(true);
      expect(reg.isEnabled('notYetRegistered')).toBe(false);
    });

    it('should respect pending remove before tool is registered', () => {
      const reg = new ToolRegistry();
      reg.remove('notYetRegistered');
      reg.register(makeTool('notYetRegistered'));
      expect(reg.isRemoved('notYetRegistered')).toBe(true);
    });

    it('should clear pending disable on enable', () => {
      const reg = new ToolRegistry();
      reg.disable('future');
      reg.enable('future');
      reg.register(makeTool('future'));
      expect(reg.isEnabled('future')).toBe(true);
    });
  });

  // ========== Supersede (re-register same name) ==========

  describe('supersede', () => {
    it('should track superseded tools', () => {
      const reg = new ToolRegistry();
      const tool1 = makeTool('foo', { description: 'v1' });
      const tool2 = makeTool('foo', { description: 'v2' });
      reg.register(tool1, 'FeatureA');
      reg.register(tool2, 'FeatureB');

      // Current tool is the latest
      expect(reg.get('foo')?.description).toBe('v2');
      expect(reg.getSource('foo')).toBe('FeatureB');

      // Entries should include superseded
      const entries = reg.getEntries();
      const superseded = entries.filter(e => e.state === 'superseded');
      expect(superseded).toHaveLength(1);
      expect(superseded[0].tool.description).toBe('v1');
      expect(superseded[0].source).toBe('FeatureA');
    });
  });

  // ========== getAll ==========

  describe('getAll', () => {
    it('should return enabled + disabled tools (LLM visible)', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('enabled'));
      reg.register(makeTool('disabled'));
      reg.register(makeTool('removed'));
      reg.disable('disabled');
      reg.remove('removed');

      const all = reg.getAll();
      const names = all.map(t => t.name).sort();
      expect(names).toEqual(['disabled', 'enabled']);
    });
  });

  // ========== isExclusive / isParallelizable ==========

  describe('isExclusive', () => {
    it('should return true for exclusive tools', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('excl', { executionMode: 'exclusive' }));
      expect(reg.isExclusive('excl')).toBe(true);
    });

    it('should return false for normal tools', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('normal'));
      expect(reg.isExclusive('normal')).toBe(false);
    });
  });

  describe('isParallelizable', () => {
    it('should return true when parallelizable and not exclusive', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('par', { parallelizable: true }));
      expect(reg.isParallelizable('par')).toBe(true);
    });

    it('should return false when exclusive even if parallelizable', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('excl', { parallelizable: true, executionMode: 'exclusive' }));
      expect(reg.isParallelizable('excl')).toBe(false);
    });

    it('should return false when not parallelizable', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('normal'));
      expect(reg.isParallelizable('normal')).toBe(false);
    });
  });

  // ========== getEntries ==========

  describe('getEntries', () => {
    it('should return entries with correct states', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('a'), 'F1');
      reg.register(makeTool('b'));
      reg.disable('b');
      reg.register(makeTool('c'));
      reg.remove('c');

      const entries = reg.getEntries();
      const states = entries.map(e => ({ name: e.tool.name, state: e.state, enabled: e.enabled }));

      const a = states.find(s => s.name === 'a')!;
      expect(a.state).toBe('enabled');
      expect(a.enabled).toBe(true);

      const b = states.find(s => s.name === 'b')!;
      expect(b.state).toBe('disabled');
      expect(b.enabled).toBe(false);

      const c = states.find(s => s.name === 'c')!;
      expect(c.state).toBe('removed');
      expect(c.enabled).toBe(false);
    });
  });

  // ========== getRenderConfig ==========

  describe('getRenderConfig', () => {
    it('should return render config for a tool', () => {
      const reg = new ToolRegistry();
      const render = { call: 'c', result: 'r' };
      reg.register(makeTool('foo', { render }));
      expect(reg.getRenderConfig('foo')).toBe(render);
    });

    it('should return undefined for tool without render', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('foo'));
      expect(reg.getRenderConfig('foo')).toBeUndefined();
    });
  });
});
