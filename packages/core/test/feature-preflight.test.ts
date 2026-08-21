/**
 * 装配预检（工作项 D）：四查 + 修复建议 + dry-run
 *
 * 验收（战略文档 §4.D）：dsh 要 mount 时才报的错，ADV 在装配编辑时就亮红。
 *
 * API 契约：
 *   preflightAssembly(features) → { ok, issues[], assembly }
 *
 * 四查（PreflightIssue.check）：
 *   inject-graph        — inject 依赖缺失/成环（error，含修复建议）
 *   policy-uniqueness   — 同一 lifecycle 上多个 policy guard（error，报 feature 名）
 *   tool-name-conflict  — 工具重名（warning：覆盖是既有语义，可能有意）
 *   manifest            — getFeatureManifest() 结构非法（error：破坏配置面板渲染）
 *
 * dry-run（assembly）：合法装配返回拓扑序 + 工具归属 + 钩子清单（kind/role）。
 * 存在 error 时不返回 assembly（装配必然不成立）。
 */
import { describe, it, expect } from 'vitest';
import { preflightAssembly } from '../src/core/feature-preflight.js';
import type { AgentFeature } from '../src/core/feature.js';

// ── Fixtures ──

class GoodFeature implements AgentFeature {
  name = 'good';
  static hooks = {
    onToolUse: { lifecycle: 'ToolUse', kind: 'guard', role: 'advisor' },
    onStepStart: { lifecycle: 'StepStart', kind: 'observe' },
  };
  getTools() {
    return [
      { name: 'good_tool', description: 'ok', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' },
    ];
  }
}

class DependentFeature implements AgentFeature {
  name = 'dependent';
  static inject = ['good'];
  getTools() { return []; }
}

class MissingDepFeature implements AgentFeature {
  name = 'missing-dep';
  static inject = ['ghost'];
  getTools() { return []; }
}

class PolicyA implements AgentFeature {
  name = 'policy-a';
  static hooks = {
    guard: { lifecycle: 'ToolUse', kind: 'guard', role: 'policy' },
  };
  getTools() { return []; }
  async guard() { return undefined; }
}

class PolicyB implements AgentFeature {
  name = 'policy-b';
  static hooks = {
    guard: { lifecycle: 'ToolUse', kind: 'guard', role: 'policy' },
  };
  getTools() { return []; }
  async guard() { return undefined; }
}

class ToolClashA implements AgentFeature {
  name = 'clash-a';
  getTools() {
    return [{ name: 'shared_tool', description: 'a', parameters: { type: 'object', properties: {} }, execute: async () => 'a' }];
  }
}

class ToolClashB implements AgentFeature {
  name = 'clash-b';
  getTools() {
    return [{ name: 'shared_tool', description: 'b', parameters: { type: 'object', properties: {} }, execute: async () => 'b' }];
  }
}

class BadManifestFeature implements AgentFeature {
  name = 'bad-manifest';
  getTools() { return []; }
  getFeatureManifest() {
    return {
      settings: {
        sections: [{ id: 's', title: 'S', properties: ['ghost-key'] }],
        properties: {
          x: { type: 'weird-type', title: 'X' },
        },
      },
    };
  }
}

describe('preflightAssembly (D: 装配预检)', () => {
  it('passes a sound assembly and returns the dry-run manifest', () => {
    const result = preflightAssembly([new GoodFeature(), new DependentFeature()]);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.assembly).not.toBeNull();
    // 拓扑序：依赖（good）先于依赖方（dependent）
    expect(result.assembly!.order).toEqual(['good', 'dependent']);
    expect(result.assembly!.tools).toEqual([
      { name: 'good_tool', feature: 'good' },
    ]);
    expect(result.assembly!.hooks).toEqual([
      { lifecycle: 'StepStart', feature: 'good', methodName: 'onStepStart', kind: 'observe', role: undefined },
      { lifecycle: 'ToolUse', feature: 'good', methodName: 'onToolUse', kind: 'guard', role: 'advisor' },
    ]);
  });

  it('reports missing inject dependency as error with fix guidance', () => {
    const result = preflightAssembly([new MissingDepFeature()]);

    expect(result.ok).toBe(false);
    const issue = result.issues.find(i => i.check === 'inject-graph')!;
    expect(issue.severity).toBe('error');
    expect(issue.features).toEqual(['missing-dep']);
    expect(issue.message).toContain('ghost');
    expect(issue.message).toContain('修复');
    expect(result.assembly).toBeNull();
  });

  it('reports circular inject dependencies as error', () => {
    class CycleA implements AgentFeature {
      name = 'cycle-a';
      static inject = ['cycle-b'];
      getTools() { return []; }
    }
    class CycleB implements AgentFeature {
      name = 'cycle-b';
      static inject = ['cycle-a'];
      getTools() { return []; }
    }

    const result = preflightAssembly([new CycleA(), new CycleB()]);

    expect(result.ok).toBe(false);
    const issue = result.issues.find(i => i.check === 'inject-graph')!;
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain('cycle-a');
    expect(issue.message).toContain('cycle-b');
  });

  it('reports duplicate policy guards on the same lifecycle as error naming both features', () => {
    const result = preflightAssembly([new PolicyA(), new PolicyB()]);

    expect(result.ok).toBe(false);
    const issue = result.issues.find(i => i.check === 'policy-uniqueness')!;
    expect(issue.severity).toBe('error');
    expect(issue.features.sort()).toEqual(['policy-a', 'policy-b']);
    expect(issue.message).toContain('ToolUse');
    expect(issue.message).toContain('advisor');
  });

  it('reports duplicate tool names as warning (supersede may be intentional)', () => {
    const result = preflightAssembly([new ToolClashA(), new ToolClashB()]);

    expect(result.ok).toBe(true); // warning 不阻断
    const issue = result.issues.find(i => i.check === 'tool-name-conflict')!;
    expect(issue.severity).toBe('warning');
    expect(issue.features.sort()).toEqual(['clash-a', 'clash-b']);
    expect(issue.message).toContain('shared_tool');
  });

  it('reports malformed manifest as error (breaks config panel rendering)', () => {
    const result = preflightAssembly([new BadManifestFeature()]);

    expect(result.ok).toBe(false);
    const manifestIssues = result.issues.filter(i => i.check === 'manifest');
    expect(manifestIssues.length).toBeGreaterThanOrEqual(2);
    // ghost-key 被 sections 引用但 properties 中不存在
    expect(manifestIssues.some(i => i.message.includes('ghost-key'))).toBe(true);
    // 非法 type
    expect(manifestIssues.some(i => i.message.includes('weird-type'))).toBe(true);
  });

  it('aggregates issues from multiple checks in one pass', () => {
    const result = preflightAssembly([
      new MissingDepFeature(),
      new PolicyA(),
      new PolicyB(),
      new ToolClashA(),
      new ToolClashB(),
    ]);

    expect(result.ok).toBe(false);
    const checks = new Set(result.issues.map(i => i.check));
    expect(checks.has('inject-graph')).toBe(true);
    expect(checks.has('policy-uniqueness')).toBe(true);
    expect(checks.has('tool-name-conflict')).toBe(true);
    expect(result.assembly).toBeNull();
  });
});

// ── mountFeature 集成：增量装配点自动预检 ──

describe('mountFeature preflight integration', () => {
  it('rejects mounting a feature that breaks policy uniqueness, keeping the agent untouched', async () => {
    const { Agent } = await import('../src/core/agent.js');
    const agent = new Agent({
      llm: { modelName: 'mock', chat: async () => ({ content: 'ok' }) } as never,
    });

    class ExistingPolicy implements AgentFeature {
      name = 'existing-policy';
      static hooks = { guard: { lifecycle: 'ToolUse', kind: 'guard', role: 'policy' } };
      getTools() { return []; }
      async guard() { return undefined; }
    }
    class ConflictingPolicy implements AgentFeature {
      name = 'conflicting-policy';
      static hooks = { guard: { lifecycle: 'ToolUse', kind: 'guard', role: 'policy' } };
      getTools() { return []; }
      async guard() { return undefined; }
    }

    agent.use(new ExistingPolicy());
    await agent.onCall('init');
    expect(agent.features.has('existing-policy')).toBe(true);

    // 挂载冲突 feature 被拒绝（fail loud），原装配不受影响
    await expect(agent.mountFeature(new ConflictingPolicy() as never))
      .rejects.toThrow(/policy-uniqueness|policy guard/);
    expect(agent.features.has('conflicting-policy')).toBe(false);
    expect(agent.features.has('existing-policy')).toBe(true);
  });

  it('allows mounting when preflight passes (warnings do not block)', async () => {
    const { Agent } = await import('../src/core/agent.js');
    const agent = new Agent({
      llm: { modelName: 'mock', chat: async () => ({ content: 'ok' }) } as never,
    });
    await agent.onCall('init');

    class ToolOwnerA implements AgentFeature {
      name = 'owner-a';
      getTools() {
        return [{ name: 'dup_tool', description: 'a', parameters: { type: 'object', properties: {} }, execute: async () => 'a' }];
      }
    }
    class ToolOwnerB implements AgentFeature {
      name = 'owner-b';
      getTools() {
        return [{ name: 'dup_tool', description: 'b', parameters: { type: 'object', properties: {} }, execute: async () => 'b' }];
      }
    }

    await agent.mountFeature(new ToolOwnerA() as never);
    // 工具重名是 warning，不阻断挂载
    await agent.mountFeature(new ToolOwnerB() as never);
    expect(agent.features.has('owner-b')).toBe(true);
  });
});
