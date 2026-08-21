/**
 * 静态声明 → inspector → 前端 normalize 往返测试（工作项 A 链路）
 *
 * 链路：static hooks 声明 → HooksRegistry.collectFromFeature → getSnapshot()
 *   → JSON 序列化（模拟 IPC 传输）→ normalizeHookInspector（viewer-html）
 *   → 字段全集保真断言。
 *
 * 背景（历史踩坑）：standaloneTools 曾在 normalizeHookInspector 重建对象时被
 * 静默丢弃。本测试将整条链路的字段保真固化为契约——任何一跳丢字段、改名、
 * 乱命名都会在此爆出。
 *
 * 同时固化字段名契约：HookEntryMetadata 的字段集合（camelCase，JSON 传输不转 snake_case）。
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { VIEWER_JS_INSPECTOR } from '../src/viewer-html/js-inspector.js';
import { HooksRegistry } from '@agentdev/core';
import { CoreLifecycle, Decision } from '@agentdev/core';
import type { AgentFeature } from '@agentdev/core';
import type {
  ToolContext,
  StepStartContext,
  StepFinishDecisionContext,
  ToolResultTransformContext,
} from '@agentdev/core';
import type { ToolExecResult } from '@agentdev/core';

function createInspectorSandbox(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(VIEWER_JS_INSPECTOR, sandbox);
  return sandbox;
}

/** HookEntryMetadata 字段名契约（camelCase；新增字段必须同步两端 normalize 与此契约） */
const HOOK_ENTRY_FIELDS = [
  'order',
  'featureName',
  'methodName',
  'lifecycle',
  'kind',
  'source',
  'description',
  'enabled',
  'role',
] as const;

describe('static declaration → registry → snapshot → normalize round-trip', () => {
  it('preserves every field of declared hooks through the full pipeline', () => {
    class GuardFeature implements AgentFeature {
      name = 'gatekeeper';
      description = 'policy guard demo';
      static hooks = {
        beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
        onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
        onStepFinish: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard', role: 'advisor' },
        rewriteResult: { lifecycle: CoreLifecycle.ToolResultTransform, kind: 'transform' },
      };

      beforeTool(_ctx: ToolContext) {
        return Decision.Continue;
      }
      onStepStart(_ctx: StepStartContext): void {}
      onStepFinish(_ctx: StepFinishDecisionContext) {
        return Decision.Continue;
      }
      rewriteResult(_ctx: ToolResultTransformContext): ToolExecResult | undefined {
        return undefined;
      }
      getHookDescription(lifecycle: string, method: string): string | undefined {
        return `${lifecycle}#${method} of gatekeeper`;
      }
    }

    const registry = new HooksRegistry();
    registry.collectFromFeature(new GuardFeature());

    // 第 1 跳：snapshot
    const snapshot = registry.getSnapshot();

    // 第 2 跳：JSON 序列化（模拟 IPC 传输边界）
    const transmitted = JSON.parse(JSON.stringify(snapshot));

    // 第 3 跳：viewer-html normalize
    const sandbox = createInspectorSandbox();
    const normalize = sandbox.normalizeHookInspector as (s: unknown) => any;
    const normalized = normalize({ lifecycleOrder: [], features: [], hooks: transmitted });

    // ---- 字段保真断言 ----
    const byLifecycle = new Map(normalized.hooks.map((g: any) => [g.lifecycle, g]));

    // guard + policy 条目
    const toolUse = byLifecycle.get('ToolUse');
    expect(toolUse.kind).toBe('guard');
    const guardEntry = toolUse.entries[0];
    expect(guardEntry.featureName).toBe('gatekeeper');
    expect(guardEntry.methodName).toBe('beforeTool');
    expect(guardEntry.role).toBe('policy');
    expect(guardEntry.order).toBe(1);
    expect(guardEntry.enabled).toBe(true);
    expect(guardEntry.description).toBe('ToolUse#beforeTool of gatekeeper');

    // observe 条目（无 role 字段）
    const stepStart = byLifecycle.get('StepStart');
    expect(stepStart.kind).toBe('observe');
    expect(stepStart.entries[0].methodName).toBe('onStepStart');
    expect(stepStart.entries[0].role).toBeUndefined();

    // guard + advisor 条目
    const stepFinish = byLifecycle.get('StepFinish');
    expect(stepFinish.kind).toBe('guard');
    expect(stepFinish.entries[0].methodName).toBe('onStepFinish');
    expect(stepFinish.entries[0].role).toBe('advisor');

    // transform 条目
    const transform = byLifecycle.get('ToolResultTransform');
    expect(transform.kind).toBe('transform');
    expect(transform.entries[0].methodName).toBe('rewriteResult');

    // ---- 字段名契约断言（不乱命名）----
    for (const group of normalized.hooks) {
      for (const entry of group.entries || []) {
        for (const key of Object.keys(entry)) {
          expect(HOOK_ENTRY_FIELDS).toContain(key);
        }
        // 关键字段必须存在（undefined 值的 role/source/description 除外）
        expect(entry).toHaveProperty('order');
        expect(entry).toHaveProperty('featureName');
        expect(entry).toHaveProperty('methodName');
        expect(entry).toHaveProperty('lifecycle');
        expect(entry).toHaveProperty('kind');
      }
    }

    // 传输前后 JSON 完全一致（normalize 不改写已存在的桶）
    const before = JSON.stringify(transmitted.find((g: any) => g.lifecycle === 'ToolUse'));
    const after = JSON.stringify(normalized.hooks.find((g: any) => g.lifecycle === 'ToolUse'));
    expect(after).toBe(before);
  });

  it('fills empty lifecycle buckets with new kind naming through normalize', () => {
    const sandbox = createInspectorSandbox();
    const normalize = sandbox.normalizeHookInspector as (s: unknown) => any;

    // 只传一个 observe 桶，其余 lifecycle 由 normalize 补空桶
    const normalized = normalize({
      lifecycleOrder: [],
      features: [],
      hooks: [
        {
          lifecycle: 'StepStart',
          kind: 'observe',
          entries: [],
        },
      ],
    });

    const byLifecycle = new Map(normalized.hooks.map((g: any) => [g.lifecycle, g]));

    // 空桶推导与框架侧 deriveKindForLifecycle 一致（三原语命名）
    expect(byLifecycle.get('ToolUse').kind).toBe('guard');
    expect(byLifecycle.get('StepFinish').kind).toBe('guard');
    expect(byLifecycle.get('ToolResultTransform').kind).toBe('transform');
    expect(byLifecycle.get('CallStart').kind).toBe('observe');
    expect(byLifecycle.get('ToolFinished').kind).toBe('observe');
    // 空桶不再出现旧命名
    const allKinds = normalized.hooks.map((g: any) => g.kind);
    expect(allKinds).not.toContain('decision');
    expect(allKinds).not.toContain('notify');
  });
});
