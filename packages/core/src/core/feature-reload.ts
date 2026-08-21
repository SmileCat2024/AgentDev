/**
 * Feature 热载（reload）— 模块加载与导出解析
 *
 * reloadFeature 的纯函数部分：
 * - resolveFeatureExport：从模块导出中定位 feature 类
 * - loadFeatureModule：cache-busting 动态 import（同路径重写后可拿到新代码）
 */

import { pathToFileURL } from 'url';
import { isAbsolute, resolve as resolvePath } from 'path';
import type { AgentFeature } from './feature.js';

/**
 * reloadFeature 的结果。
 */
export interface FeatureReloadResult {
  featureName: string;
  /** captureState/restoreState 齐备且已完成迁移；false = 无状态契约（热载丢内存状态） */
  stateTransferred: boolean;
  /** 失败回退后为 true（reloadFeature 正常路径恒 false，失败时 throw） */
  rolledBack: false;
  durationMs: number;
}

/** reloadFeature 的可选行为开关。 */
export interface FeatureReloadOptions {
  /**
   * 严格初始化：getAsyncTools / onInitiate 失败视为 reload 失败并自动回退，
   * 而不是 warn 后继续以半初始化状态挂载。默认 false（保持既有语义）。
   */
  strictInit?: boolean;
}

/** initSingleFeature 严格模式抛出的错误标记（reload 据此标注 'init' 阶段）。 */
export interface FeatureInitFailureError extends Error {
  featureInitStage: 'getAsyncTools' | 'onInitiate';
}

export function isFeatureInitFailureError(error: unknown): error is FeatureInitFailureError {
  return error instanceof Error && 'featureInitStage' in error;
}

/** reloadFeature 失败回退后重新抛出的错误标记（调用方可结构化消费）。 */
export interface FeatureReloadFailureError extends Error {
  /** 失败阶段：import / instantiate / state-transfer / mount / init */
  reloadStage: string;
  /** 恒 true：旧实例已恢复 */
  rolledBack: true;
}

type FeatureConstructor = new (...args: never[]) => AgentFeature;

function isConstructorLike(value: unknown): value is FeatureConstructor {
  return typeof value === 'function' && /^\s*class\s+/.test(
    Function.prototype.toString.call(value),
  );
}

/**
 * 从模块导出中定位 feature 类。
 *
 * 解析顺序：
 * 1. 与旧实例构造器同名的具名导出（零歧义，优先）
 * 2. 模块中唯一的 class 导出（热载模块的常见形态）
 * 3. default 导出（须为 class）
 *
 * 定位到的类在实例化后还会以 feature 的 name 属性做身份校验
 * （见 reloadFeature），类名不是最终身份锚点。
 */
export function resolveFeatureExport(
  moduleExports: Record<string, unknown>,
  className?: string,
): FeatureConstructor {
  if (className && isConstructorLike(moduleExports[className])) {
    return moduleExports[className];
  }
  const classExports = Object.entries(moduleExports).filter(
    (entry): entry is [string, FeatureConstructor] => isConstructorLike(entry[1]),
  );
  if (classExports.length === 1) {
    return classExports[0][1];
  }
  if (isConstructorLike(moduleExports.default)) {
    return moduleExports.default;
  }
  const available = Object.keys(moduleExports).filter(k => k !== 'default');
  throw new Error(
    `Feature reload failed: no matching export${className ? ` for class '${className}'` : ''} ` +
      `(candidates must be a single class export, a matching name, or a class default export). ` +
      `available exports: ${available.join(', ') || '(none)'}`,
  );
}

/**
 * cache-busting 动态 import。
 *
 * 同一路径重写模块源码后，ESM 默认按 URL 缓存模块——
 * 追加时间戳 query 强制重新加载，这是热载语义的核心。
 *
 * @param modulePath 绝对路径或 file:// URL
 */
export async function importFeatureModuleFresh(modulePath: string): Promise<Record<string, unknown>> {
  const url = modulePath.startsWith('file://')
    ? modulePath
    : pathToFileURL(isAbsolute(modulePath) ? modulePath : resolvePath(modulePath)).href;
  const bustingUrl = `${url}${url.includes('?') ? '&' : '?'}reload=${Date.now()}`;
  const mod = await import(/* @vite-ignore */ bustingUrl);
  return mod as Record<string, unknown>;
}

/**
 * 加载模块并解析 feature 类。
 */
export async function loadFeatureModule(
  modulePath: string,
  className?: string,
): Promise<FeatureConstructor> {
  const moduleExports = await importFeatureModuleFresh(modulePath);
  return resolveFeatureExport(moduleExports, className);
}
