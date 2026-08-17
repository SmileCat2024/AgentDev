/**
 * 装配预检（工作项 D）：四查 + 修复建议 + dry-run
 *
 * 战略文档 §4.D：dsh 要 mount 时才报的错，ADV 在装配编辑时就亮红。
 * preflightAssembly 不实例化副作用、不挂载、不注册——纯静态读取声明与清单，
 * 供装配 UI（编辑时亮红）与 feature-creator（挂载前自检）消费。
 *
 * 四查：
 * 1. inject-graph        依赖完整性（缺失/成环），复用 resolveFeatureOrder
 * 2. policy-uniqueness   同一 lifecycle 上的 policy guard 唯一性
 * 3. tool-name-conflict  工具重名（warning：覆盖是既有语义，可能有意）
 * 4. manifest            getFeatureManifest() 结构合法性（error：破坏配置面板）
 *
 * dry-run：合法装配返回拓扑序 + 工具归属 + 钩子清单（kind/role）。
 * 存在 error 时不返回 assembly（装配必然不成立）。
 */

import { resolveFeatureOrder } from './feature-graph.js';
import { readHookDeclarations, validatePolicyUniqueness } from './hook-declarations.js';
import type { AgentFeature } from './feature.js';
import { CoreLifecycle } from './lifecycle.js';

export type PreflightCheck =
  | 'inject-graph'
  | 'policy-uniqueness'
  | 'tool-name-conflict'
  | 'manifest';

export interface PreflightIssue {
  severity: 'error' | 'warning';
  check: PreflightCheck;
  /** 问题说明 + 修复建议（一句话可执行） */
  message: string;
  /** 涉及的 feature 名 */
  features: string[];
}

export interface PreflightAssembly {
  /** 拓扑排序后的装配序（依赖先于依赖方） */
  order: string[];
  /** 工具清单：装配后将存在的工具及其来源 feature */
  tools: { name: string; feature: string }[];
  /** 钩子清单：声明将被收集的钩子（按 lifecycle 排序，组内按装配序） */
  hooks: {
    lifecycle: string;
    feature: string;
    methodName: string;
    kind: string;
    role?: string;
  }[];
}

export interface PreflightResult {
  /** 无 error 级 issue */
  ok: boolean;
  issues: PreflightIssue[];
  /** dry-run 清单；存在 error 时为 null */
  assembly: PreflightAssembly | null;
}

/** manifest properties 支持的 type 枚举（与 FeatureManifestSettingProperty 类型对齐） */
const MANIFEST_PROPERTY_TYPES = new Set([
  'string', 'number', 'boolean', 'select', 'file', 'directory', 'group',
] as const);

export function preflightAssembly(features: AgentFeature[]): PreflightResult {
  const issues: PreflightIssue[] = [];

  // ── 查 1：inject 依赖完整性（缺失/成环），复用拓扑排序的诊断 ──
  const orderResult = resolveFeatureOrder(features);
  for (const err of orderResult.errors) {
    issues.push({
      severity: 'error',
      check: 'inject-graph',
      message: err.message,
      features: featureNamesFromMessage(features, err.message),
    });
  }

  // ── 查 2：policy guard 唯一性（复用 validatePolicyUniqueness，跨 feature 聚合） ──
  for (const issue of validatePolicyUniqueness(features)) {
    issues.push({
      severity: 'error',
      check: 'policy-uniqueness',
      message: issue.message,
      features: issue.involvedFeatures ?? [issue.feature],
    });
  }

  // ── 查 3：工具重名（warning：后注册覆盖是既有语义，可能有意） ──
  const toolOwners = new Map<string, string[]>();
  for (const feature of features) {
    for (const tool of feature.getTools?.() ?? []) {
      const owners = toolOwners.get(tool.name) ?? [];
      owners.push(feature.name);
      toolOwners.set(tool.name, owners);
    }
  }
  for (const [toolName, owners] of toolOwners) {
    if (owners.length > 1) {
      issues.push({
        severity: 'warning',
        check: 'tool-name-conflict',
        message:
          `工具 '${toolName}' 被 ${owners.length} 个 feature 重复提供（${owners.join(', ')}）。` +
          '装配后后注册者生效（先注册者进入 superseded）。若非有意覆盖，请重命名其中之一。',
        features: owners,
      });
    }
  }

  // ── 查 4：manifest 结构合法性 ──
  for (const feature of features) {
    if (typeof (feature as any).getFeatureManifest !== 'function') continue;
    let manifest: unknown;
    try {
      manifest = (feature as any).getFeatureManifest();
    } catch (error) {
      issues.push({
        severity: 'error',
        check: 'manifest',
        message: `feature '${feature.name}' 的 getFeatureManifest() 抛出异常：${error instanceof Error ? error.message : String(error)}。修复：确保 getter 纯返回，无副作用。`,
        features: [feature.name],
      });
      continue;
    }
    issues.push(...validateManifest(feature.name, manifest));
  }

  const ok = !issues.some(i => i.severity === 'error');
  const assembly = ok ? buildAssembly(orderResult.order) : null;
  return { ok, issues, assembly };
}

/** 从 inject-graph 错误消息中提取涉及的 feature 名（消息由 feature-graph 生成，含全部名称） */
function featureNamesFromMessage(features: AgentFeature[], message: string): string[] {
  return features.map(f => f.name).filter(name => message.includes(name));
}

function validateManifest(featureName: string, manifest: unknown): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const settings = (manifest as any)?.settings;
  const properties = settings?.properties;

  if (!properties || typeof properties !== 'object') return issues;

  issues.push(...validateManifestProperties(featureName, '', properties));

  // sections 引用完整性
  const sections = settings?.sections;
  if (Array.isArray(sections)) {
    for (const section of sections) {
      for (const key of section?.properties ?? []) {
        if (!(key in properties)) {
          issues.push({
            severity: 'error',
            check: 'manifest',
            message: `feature '${featureName}' manifest section '${section?.id}' 引用了不存在的属性 '${key}'。修复：在 settings.properties 中补充定义，或从 section 中移除。`,
            features: [featureName],
          });
        }
      }
    }
  }

  return issues;
}

/** 属性结构校验（group 递归其嵌套 properties） */
function validateManifestProperties(
  featureName: string,
  prefix: string,
  properties: Record<string, any>,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  for (const [key, def] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!def || typeof def !== 'object') {
      issues.push({
        severity: 'error',
        check: 'manifest',
        message: `feature '${featureName}' manifest 属性 '${path}' 的定义不是对象。修复：提供 { type, title, ... } 形态。`,
        features: [featureName],
      });
      continue;
    }
    if (typeof def.type !== 'string' || !MANIFEST_PROPERTY_TYPES.has(def.type)) {
      issues.push({
        severity: 'error',
        check: 'manifest',
        message: `feature '${featureName}' manifest 属性 '${path}' 的 type '${def.type}' 不在支持枚举内（${[...MANIFEST_PROPERTY_TYPES].join('/')}）。修复：改用受支持的 type。`,
        features: [featureName],
      });
    }
    if (def.type === 'group' && def.properties && typeof def.properties === 'object') {
      issues.push(...validateManifestProperties(featureName, path, def.properties));
    }
  }
  return issues;
}

function buildAssembly(orderedFeatures: AgentFeature[]): PreflightAssembly {
  const order = orderedFeatures.map(f => f.name);

  const tools: PreflightAssembly['tools'] = [];
  for (const feature of orderedFeatures) {
    for (const tool of feature.getTools?.() ?? []) {
      tools.push({ name: tool.name, feature: feature.name });
    }
  }

  const hooks: PreflightAssembly['hooks'] = [];
  for (const feature of orderedFeatures) {
    const declarations = readHookDeclarations(feature);
    for (const [method, decl] of Object.entries(declarations)) {
      hooks.push({
        lifecycle: decl.lifecycle,
        feature: feature.name,
        methodName: method,
        kind: decl.kind,
        role: decl.role,
      });
    }
  }
  // 按 lifecycle 排序（面板按生命周期分组展示），组内保持装配序（稳定排序）
  const lifecycleOrder = Object.values(CoreLifecycle);
  hooks.sort((a, b) => {
    const ia = lifecycleOrder.indexOf(a.lifecycle as CoreLifecycle);
    const ib = lifecycleOrder.indexOf(b.lifecycle as CoreLifecycle);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  return { order, tools, hooks };
}
