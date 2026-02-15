/**
 * 工具加载器
 * 负责从指定目录加载工具及其渲染模板
 */

import type { Tool } from '../core/types.js';
import { isTool } from './utils.js';

/**
 * 工具模块类型
 */
interface ToolModule {
  [key: string]: unknown;
}

/**
 * 从指定目录加载工具
 * 使用显式 import 方式，适用于 ES Module
 *
 * @param dirPath 工具目录路径（相对于 src/tools/）
 * @returns 工具数组
 */
export async function loadToolsFromDir(dirPath: string): Promise<Tool[]> {
  // 标准化路径，确保以 / 结尾
  let normalizedPath = dirPath;
  if (!normalizedPath.endsWith('/')) {
    normalizedPath += '/';
  }

  try {
    // 使用动态 import 加载工具模块
    const modules = await importToolModules(normalizedPath);

    // 从每个模块中提取工具
    const tools: Tool[] = [];

    for (const module of modules) {
      if (module && typeof module === 'object') {
        for (const exportName of Object.keys(module)) {
          const exportValue = (module as ToolModule)[exportName];

          // 检查是否为工具（有 name 和 execute 属性，且 execute 是函数）
          if (isTool(exportValue)) {
            tools.push(exportValue as Tool);
          }
        }
      }
    }

    return tools;
  } catch (error) {
    console.error(`Failed to load tools from ${dirPath}:`, error);
    return [];
  }
}

/**
 * 动态加载工具模块
 * 根据目录路径加载相应的模块
 */
async function importToolModules(basePath: string): Promise<ToolModule[]> {
  // 根据路径映射到具体的导入
  const modulesMap: Record<string, () => Promise<ToolModule[]>> = {
    './system/': async () => {
      const modules = await Promise.all([
        import('./system/fs.js'),
        import('./system/shell.js'),
        import('./system/web.js'),
        import('./system/math.js'),
        import('./system/skill.js'),
      ]);
      return modules as ToolModule[];
    },
    './user/': async () => {
      const modules = await Promise.all([
        import('./user/database.js'),
      ]);
      return modules as ToolModule[];
    },
    'system/': async () => {
      const modules = await Promise.all([
        import('./system/fs.js'),
        import('./system/shell.js'),
        import('./system/web.js'),
        import('./system/math.js'),
        import('./system/skill.js'),
      ]);
      return modules as ToolModule[];
    },
    'user/': async () => {
      const modules = await Promise.all([
        import('./user/database.js'),
      ]);
      return modules as ToolModule[];
    },
  };

  // 尝试直接匹配，或添加 ./ 前缀后匹配
  const importFn = modulesMap[basePath] || modulesMap[`./${basePath}`];
  if (!importFn) {
    console.warn(`No import mapping found for path: ${basePath}`);
    return [];
  }

  return importFn();
}

/**
 * 加载系统工具
 */
export async function loadSystemTools(): Promise<Tool[]> {
  return loadToolsFromDir('system/');
}

/**
 * 加载用户工具
 */
export async function loadUserTools(): Promise<Tool[]> {
  return loadToolsFromDir('user/');
}

/**
 * 加载所有工具（系统 + 用户）
 */
export async function loadAllTools(): Promise<Tool[]> {
  const [systemTools, userTools] = await Promise.all([
    loadSystemTools(),
    loadUserTools(),
  ]);

  return [...systemTools, ...userTools];
}
