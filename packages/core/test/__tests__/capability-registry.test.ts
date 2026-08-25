import { describe, it, expect } from 'vitest';
import { CapabilityRegistry } from '../../src/core/capability.js';
import type { CapabilityContext, CapabilityDefinition } from '../../src/core/capability.js';

function makeCtx(): CapabilityContext {
  return {
    agentId: 'test-agent',
    getFeature: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as CapabilityContext['logger'],
  };
}

function makeDef(name: string, opts?: Partial<CapabilityDefinition>): CapabilityDefinition {
  return {
    name,
    execute: async () => `${name}:ok`,
    ...opts,
  };
}

describe('CapabilityRegistry.register', () => {
  it('should register and produce snapshot with default entryPoints', () => {
    const reg = new CapabilityRegistry();
    reg.register('my-feature', makeDef('reload', { title: 'Reload', description: 'Reload the thing' }));
    const [snap] = reg.list();
    expect(snap).toMatchObject({
      feature: 'my-feature',
      name: 'reload',
      ref: 'my-feature.reload',
      title: 'Reload',
      description: 'Reload the thing',
      entryPoints: ['feature'],
    });
    expect(reg.has('my-feature.reload')).toBe(true);
  });

  it('should fall back title to name when absent', () => {
    const reg = new CapabilityRegistry();
    reg.register('f', makeDef('compact'));
    expect(reg.list()[0].title).toBe('compact');
  });

  it('should throw on duplicate ref', () => {
    const reg = new CapabilityRegistry();
    reg.register('f', makeDef('go'));
    expect(() => reg.register('f', makeDef('go'))).toThrow(/duplicate capability ref "f\.go"/);
  });

  it('should throw on invalid command name', () => {
    const reg = new CapabilityRegistry();
    expect(() => reg.register('f', makeDef('has space'))).toThrow(/invalid command name/);
    expect(() => reg.register('f', makeDef(''))).toThrow(/invalid command name/);
  });
});

describe('CapabilityRegistry.list filter', () => {
  it('should filter by entryPoint', () => {
    const reg = new CapabilityRegistry();
    reg.register('f', makeDef('userCmd', { entryPoints: ['slash', 'feature'] }));
    reg.register('f', makeDef('internalOnly'));
    expect(reg.list({ entryPoint: 'slash' }).map((s) => s.ref)).toEqual(['f.userCmd']);
    expect(reg.list().map((s) => s.ref).sort()).toEqual(['f.internalOnly', 'f.userCmd']);
  });
});

describe('CapabilityRegistry.invoke', () => {
  it('should return ok with result and default empty args', async () => {
    const reg = new CapabilityRegistry();
    let received: Record<string, unknown> | undefined;
    reg.register('f', {
      name: 'run',
      execute: async (args) => {
        received = args;
        return { done: true };
      },
    });
    const res = await reg.invoke('f.run', { entryPoint: 'feature' }, makeCtx());
    expect(res).toEqual({ ok: true, result: { done: true } });
    expect(received).toEqual({});
  });

  it('should return not_found for unknown ref', async () => {
    const reg = new CapabilityRegistry();
    const res = await reg.invoke('nope.nothing', { entryPoint: 'feature' }, makeCtx());
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('should deny slash-only capability from feature entry point', async () => {
    const reg = new CapabilityRegistry();
    reg.register('f', makeDef('userOnly', { entryPoints: ['slash'] }));
    const res = await reg.invoke('f.userOnly', { entryPoint: 'feature' }, makeCtx());
    expect(res).toMatchObject({ ok: false, code: 'entry_point_denied' });
  });

  it('should deny feature-only capability from slash entry point', async () => {
    const reg = new CapabilityRegistry();
    reg.register('f', makeDef('internalOnly'));
    const res = await reg.invoke('f.internalOnly', { entryPoint: 'slash' }, makeCtx());
    expect(res).toMatchObject({ ok: false, code: 'entry_point_denied' });
  });

  it('should normalize execute errors to execute_failed', async () => {
    const reg = new CapabilityRegistry();
    reg.register('f', {
      name: 'boom',
      execute: async () => {
        throw new Error('exploded');
      },
    });
    const res = await reg.invoke('f.boom', { entryPoint: 'feature' }, makeCtx());
    expect(res).toMatchObject({ ok: false, code: 'execute_failed', message: 'exploded' });
  });

  it('should return timeout without hanging the caller', async () => {
    const reg = new CapabilityRegistry();
    reg.register('f', {
      name: 'slow',
      execute: () => new Promise((resolve) => setTimeout(resolve, 500)),
    });
    const res = await reg.invoke('f.slow', { entryPoint: 'feature', timeoutMs: 20 }, makeCtx());
    expect(res).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('should pass args and context through', async () => {
    const reg = new CapabilityRegistry();
    let seenCtx: CapabilityContext | undefined;
    reg.register('f', {
      name: 'run',
      execute: async (args, ctx) => {
        seenCtx = ctx;
        return args;
      },
    });
    const ctx = makeCtx();
    const res = await reg.invoke('f.run', { entryPoint: 'feature', args: { a: 1 } }, ctx);
    expect(res).toEqual({ ok: true, result: { a: 1 } });
    expect(seenCtx).toBe(ctx);
  });
});
