/**
 * 工具定义
 * 简单的工具创建函数
 */

import type { Tool, ToolRenderConfig } from './types.js';

/**
 * 渲染配置扩展类型
 * 支持字符串（模板名称）或配置对象
 */
export type ToolRenderInput = ToolRenderConfig | string;

/**
 * 创建一个工具
 * @param config 工具配置
 * @param sourceFile 可选：调用此函数的源文件路径（用于自动查找渲染文件）
 */
export function createTool(
  config: {
    name: string;
    description: string;
    parameters?: Record<string, any>;
    execute: (args: any, context?: any) => Promise<any>;
    render?: ToolRenderInput;
  },
  sourceFile?: string
): Tool {
  let finalRender: ToolRenderConfig | undefined = undefined;

  if (config.render) {
    // 如果 render 是字符串，转换为配置对象（call 和 result 使用同一模板）
    if (typeof config.render === 'string') {
      finalRender = {
        call: config.render,
        result: config.render,
      };
    } else {
      finalRender = config.render;
    }
  } else if (sourceFile) {
    // render 未定义时，尝试自动查找同目录下的 .render.ts 文件
    // 例如：tools/fs.ts -> tools/fs.render.ts
    const renderPath = sourceFile.replace(/\.ts$/, '.render.ts');
    // 使用特殊标记，延迟加载
    (finalRender as any) = {
      __renderPath: renderPath,
      call: undefined,
      result: undefined,
    };
  }

  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
    render: finalRender,
  };
}

/**
 * 工具注册表 - 管理多个工具
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private enabled = new Set<string>();      // 启用的工具名
  private sources = new Map<string, string>(); // 工具来源追踪

  /**
   * 注册工具（默认启用，记录来源）
   */
  register(tool: Tool, source?: string): this {
    this.tools.set(tool.name, tool);
    this.enabled.add(tool.name);  // 默认启用
    if (source) {
      this.sources.set(tool.name, source);
    }
    return this;
  }

  /**
   * 禁用工具
   */
  disable(name: string): boolean {
    return this.enabled.delete(name);
  }

  /**
   * 启用工具
   */
  enable(name: string): boolean {
    if (this.tools.has(name)) {
      this.enabled.add(name);
      return true;
    }
    return false;
  }

  /**
   * 检查工具是否启用
   */
  isEnabled(name: string): boolean {
    return this.enabled.has(name);
  }

  /**
   * 获取工具来源（调试用）
   */
  getSource(name: string): string | undefined {
    return this.sources.get(name);
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有工具（只返回启用的）
   */
  getAll(): Tool[] {
    return Array.from(this.enabled)
      .map(name => this.tools.get(name))
      .filter((t): t is Tool => t !== undefined);
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取工具的渲染配置
   */
  getRenderConfig(name: string): ToolRenderConfig | undefined {
    const tool = this.tools.get(name);
    return tool?.render;
  }
}
