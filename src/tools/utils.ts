/**
 * 工具相关工具函数
 */

import type { Tool } from '../core/types.js';

/**
 * 检查一个值是否为工具
 *
 * @param v 待检查的值
 * @returns 是否为工具
 */
export function isTool(v: unknown): v is Tool {
  return (
    typeof v === 'object' &&
    v !== null &&
    'name' in v &&
    typeof (v as Tool).name === 'string' &&
    'execute' in v &&
    typeof (v as Tool).execute === 'function'
  );
}

/**
 * 检查一个值是否为工具数组
 *
 * @param v 待检查的值
 * @returns 是否为工具数组
 */
export function isToolArray(v: unknown): v is Tool[] {
  return Array.isArray(v) && v.every(isTool);
}

/**
 * 从对象数组中提取工具
 *
 * @param modules 模块对象数组
 * @returns 工具数组
 */
export function extractToolsFromModules(modules: unknown[]): Tool[] {
  const tools: Tool[] = [];

  for (const module of modules) {
    if (typeof module === 'object' && module !== null) {
      for (const exportName of Object.keys(module)) {
        const exportValue = (module as Record<string, unknown>)[exportName];

        if (isTool(exportValue)) {
          tools.push(exportValue);
        }
      }
    }
  }

  return tools;
}
