/**
 * 工具定义
 * 简单的工具创建函数
 */

import type { Tool } from './types.js';

/**
 * 创建一个工具
 */
export function createTool(config: {
  name: string;
  description: string;
  parameters?: Record<string, any>;
  execute: (args: any) => Promise<any>;
}): Tool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
  };
}

/**
 * 工具注册表 - 管理多个工具
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /**
   * 注册工具
   */
  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有工具
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }
}
