/**
 * Feature 依赖拓扑排序（工作项 A3）
 *
 * Feature 类通过静态属性声明依赖：
 *
 * ```typescript
 * class RouterFeature implements AgentFeature {
 *   name = 'router';
 *   static inject = ['storage', 'auth'];
 * }
 * ```
 *
 * 装配时（ensureFeatureTools 前）解析依赖图：
 * - 拓扑排序决定初始化顺序（依赖先于依赖方）
 * - 缺失依赖 / 循环依赖 = 启动错误，带修复建议与环路径
 * - 无声明时保持装配顺序（use() 插入序）
 *
 * 静态可读是关键：声明挂在 constructor 上，装配预检（工作项 D）
 * 无需运行 feature 代码即可校验依赖完整性——这是与
 * 运行时软失败 locator（getFeature 延迟爆炸）的本质区别。
 */

import type { AgentFeature } from './feature.js';

/** 结构化装配错误（供启动报错与装配预检共用） */
export type FeatureOrderErrorCode =
  | 'missing_dependency'
  | 'circular_dependency'
  | 'duplicate_feature_name';

export interface FeatureOrderError {
  code: FeatureOrderErrorCode;
  message: string;
}

export interface FeatureOrderResult {
  /** 拓扑排序后的初始化顺序。有错误时为空数组。 */
  order: AgentFeature[];
  errors: FeatureOrderError[];
}

/**
 * 读取 Feature 的静态 inject 声明。
 *
 * 无声明返回空数组（该 feature 无依赖约束）。
 */
export function readInjectDeclarations(feature: AgentFeature): string[] {
  const raw = (feature.constructor as any)?.inject;
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is string => typeof d === 'string' && d.length > 0);
}

/**
 * 解析 feature 列表的初始化顺序（拓扑排序）。
 *
 * 稳定性：同层（互不依赖）feature 保持装配顺序。
 * 任何错误发生时不输出部分顺序（order 为空），由调用方决定报错方式。
 */
export function resolveFeatureOrder(features: AgentFeature[]): FeatureOrderResult {
  const errors: FeatureOrderError[] = [];

  // 重名校验：名字是依赖图的节点键，重名意味着图本身不成立
  const byName = new Map<string, AgentFeature>();
  for (const feature of features) {
    if (byName.has(feature.name)) {
      errors.push({
        code: 'duplicate_feature_name',
        message: `装配中出现了两个名为 '${feature.name}' 的 Feature。修复：Feature name 是依赖图与工具来源的键，必须唯一。`,
      });
    }
    byName.set(feature.name, feature);
  }
  if (errors.length > 0) {
    return { order: [], errors };
  }

  // 建图：name → 依赖列表（只含装配内存在的依赖；缺失的单独报错）
  const graph = new Map<string, string[]>();
  for (const feature of features) {
    const inject = readInjectDeclarations(feature);
    const valid: string[] = [];
    for (const dep of inject) {
      if (!byName.has(dep)) {
        errors.push({
          code: 'missing_dependency',
          message: `Feature '${feature.name}' 声明了 static inject = [..., '${dep}', ...]，但装配中不存在名为 '${dep}' 的 Feature。修复：先 use() 该依赖，或从 static inject 中移除 '${dep}'。`,
        });
        continue;
      }
      valid.push(dep);
    }
    graph.set(feature.name, valid);
  }
  if (errors.length > 0) {
    return { order: [], errors };
  }

  // 循环依赖检测（DFS 三色标记，输出环路径）
  const cycleError = detectCycle(features.map(f => f.name), graph);
  if (cycleError) {
    return { order: [], errors: [cycleError] };
  }

  // DFS 后序展开（装配序驱动）：
  // 按装配顺序访问每个 feature，未就绪的依赖先递归展开。
  // 结果语义 = 最小移动：只把依赖提前到首个依赖方之前，其余相对序完全保持——
  // 装配序是作者显式意图（工具注册序、observe 日志序），拓扑排序只做必要调整。
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of graph.get(name) ?? []) {
      visit(dep);
    }
    ordered.push(name);
  };
  for (const feature of features) {
    visit(feature.name);
  }

  return { order: ordered.map(name => byName.get(name)!), errors: [] };
}

/**
 * DFS 三色标记环检测。
 *
 * 返回带环路径的错误（如 "a → b → c → a"），未发现环返回 undefined。
 */
function detectCycle(names: string[], graph: Map<string, string[]>): FeatureOrderError | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const color = new Map<string, number>(names.map(n => [n, WHITE]));
  const path: string[] = [];

  function dfs(node: string): string[] | undefined {
    color.set(node, GRAY);
    path.push(node);

    for (const dep of graph.get(node) ?? []) {
      if (color.get(dep) === GRAY) {
        // 从 path 中 dep 第一次出现处截取，得到完整环
        const start = path.indexOf(dep);
        return [...path.slice(start), dep];
      }
      if (color.get(dep) === WHITE) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    path.pop();
    color.set(node, BLACK);
    return undefined;
  }

  for (const name of names) {
    if (color.get(name) !== WHITE) continue;
    const cycle = dfs(name);
    if (cycle) {
      return {
        code: 'circular_dependency',
        message: `Feature 依赖成环：${cycle.join(' → ')}。修复：环上的某个 static inject 声明有误，请检查依赖方向；跨 feature 的循环协作应改用运行时 getFeature 软查找。`,
      };
    }
  }
  return undefined;
}

/**
 * 将装配错误转成单一 Error（启动路径使用）。
 */
export function orderErrorsToError(errors: FeatureOrderError[]): Error {
  const lines = errors.map(e => `[${e.code}] ${e.message}`);
  return new Error(`Feature 装配校验失败（${errors.length} 个问题）：\n${lines.join('\n')}`);
}
