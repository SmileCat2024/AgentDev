import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { VIEWER_JS_INSPECTOR } from '../core/viewer-html/js-inspector.js';
import type { HookInspectorSnapshot } from '../core/types.js';

/**
 * Round-trip 测试：验证 HookInspectorSnapshot 经过 viewer-html 的
 * normalizeHookInspector() 后，所有字段完整保留。
 *
 * 背景：standaloneTools 字段曾因 normalizeHookInspector 重建对象时遗漏
 * 而被静默丢弃（CLAUDE.md 已记录此历史踩坑）。此测试确保该字段及
 * 未来新增字段不会再被吞掉。
 *
 * normalizeHookInspector 定义在模板字符串 VIEWER_JS_INSPECTOR 中，
 * 无法直接 import，需要通过 vm 沙箱加载后调用。
 */

function createInspectorSandbox(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  // VIEWER_JS_INSPECTOR 定义了一组 function 声明，
  // 在 vm context 中执行后这些函数会挂在 sandbox 上
  vm.runInContext(VIEWER_JS_INSPECTOR, sandbox);
  return sandbox;
}

function buildFullSnapshot(): HookInspectorSnapshot {
  return {
    lifecycleOrder: ['CallStart', 'StepStart', 'StepFinish'],
    features: [
      {
        name: 'shell',
        enabled: true,
        status: 'enabled',
        hookCount: 2,
        toolCount: 3,
        enabledToolCount: 3,
        source: 'ShellFeature',
        description: 'Shell execution',
        tools: [
          {
            name: 'bash',
            description: 'Run bash command',
            state: 'enabled',
            enabled: true,
            renderCall: 'shell/bash.render',
            renderResult: 'shell/bash.render',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The command to execute' },
              },
              required: ['command'],
            },
          },
        ],
      },
    ],
    hooks: [
      {
        lifecycle: 'StepFinish',
        kind: 'decision',
        entries: [
          {
            order: 0,
            featureName: 'todo',
            methodName: 'recordToolUsage',
            lifecycle: 'StepFinish',
            kind: 'decision',
            description: 'Check interrupt target',
          },
        ],
      },
    ],
    standaloneTools: [
      {
        name: 'custom_tool',
        description: 'A standalone tool',
        state: 'enabled',
        enabled: true,
        source: 'custom-source',
        renderCall: 'custom/render',
        renderResult: 'custom/render',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
      },
    ],
  };
}

describe('viewer-html normalizeHookInspector round-trip', () => {
  it('preserves standaloneTools through normalize', () => {
    const sandbox = createInspectorSandbox();
    const normalize = sandbox.normalizeHookInspector as (s: unknown) => Record<string, unknown>;

    const input = buildFullSnapshot();
    const output = normalize(input);

    // 这是历史上被丢弃的字段
    expect(output.standaloneTools).toBeDefined();
    expect(output.standaloneTools).toHaveLength(1);
    expect(output.standaloneTools[0].name).toBe('custom_tool');
    expect(output.standaloneTools[0].source).toBe('custom-source');
    expect(output.standaloneTools[0].parameters).toBeDefined();
    expect(output.standaloneTools[0].parameters).toEqual({
      type: 'object',
      properties: { input: { type: 'string' } },
    });
  });

  it('preserves features and their tools through normalize', () => {
    const sandbox = createInspectorSandbox();
    const normalize = sandbox.normalizeHookInspector as (s: unknown) => Record<string, unknown>;

    const input = buildFullSnapshot();
    const output = normalize(input);

    expect(output.features).toHaveLength(1);
    const feature = output.features[0];
    expect(feature.name).toBe('shell');
    expect(feature.source).toBe('ShellFeature');
    expect(feature.description).toBe('Shell execution');
    expect(feature.tools).toHaveLength(1);
    expect(feature.tools[0].name).toBe('bash');
    expect(feature.tools[0].renderCall).toBe('shell/bash.render');
    expect(feature.tools[0].parameters).toBeDefined();
    expect(feature.tools[0].parameters).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
      },
      required: ['command'],
    });
  });

  it('preserves hooks entries through normalize', () => {
    const sandbox = createInspectorSandbox();
    const normalize = sandbox.normalizeHookInspector as (s: unknown) => Record<string, unknown>;

    const input = buildFullSnapshot();
    const output = normalize(input);

    // normalizeHookInspector 按 FULL_HOOK_LIFECYCLE_ORDER 补齐缺失的 lifecycle，
    // 所以输出 hooks 数组会比输入更长。但输入中已有的 lifecycle 条目应原样保留。
    const stepFinishGroup = output.hooks.find((h: any) => h.lifecycle === 'StepFinish');
    expect(stepFinishGroup).toBeDefined();
    expect(stepFinishGroup.kind).toBe('decision');
    expect(stepFinishGroup.entries).toHaveLength(1);
    expect(stepFinishGroup.entries[0].featureName).toBe('todo');
    expect(stepFinishGroup.entries[0].description).toBe('Check interrupt target');
  });

  it('handles missing standaloneTools gracefully (returns undefined)', () => {
    const sandbox = createInspectorSandbox();
    const normalize = sandbox.normalizeHookInspector as (s: unknown) => Record<string, unknown>;

    const input = buildFullSnapshot();
    delete input.standaloneTools;
    const output = normalize(input);

    expect(output.standaloneTools).toBeUndefined();
  });

  it('preserves tools without parameters field (graceful undefined)', () => {
    const sandbox = createInspectorSandbox();
    const normalize = sandbox.normalizeHookInspector as (s: unknown) => Record<string, unknown>;

    const input = buildFullSnapshot();
    // 移除 parameters 字段，模拟无 schema 的工具
    delete input.features[0].tools[0].parameters;
    const output = normalize(input);

    expect(output.features[0].tools[0].parameters).toBeUndefined();
  });
});
