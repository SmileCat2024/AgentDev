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
    executionMode?: 'normal' | 'exclusive';
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
    ...(config.executionMode ? { executionMode: config.executionMode } : {}),
  };
}

/**
 * 工具注册表 - 管理多个工具
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private enabled = new Set<string>();        // 启用的工具名
  private disabled = new Set<string>();       // 禁用（屏蔽）的工具名
  private pendingDisabled = new Set<string>(); // 工具注册前的预禁用状态
  private pendingRemoved = new Set<string>();  // 工具注册前的预移除状态
  private sources = new Map<string, string>(); // 工具来源追踪
  private superseded = new Map<string, Array<{ tool: Tool; source?: string }>>(); // 被同名覆盖的旧条目

  /**
   * 注册工具（默认启用，记录来源）
   */
  register(tool: Tool, source?: string): this {
    // 追踪被覆盖的旧条目
    if (this.tools.has(tool.name)) {
      if (!this.superseded.has(tool.name)) {
        this.superseded.set(tool.name, []);
      }
      this.superseded.get(tool.name)!.push({
        tool: this.tools.get(tool.name)!,
        source: this.sources.get(tool.name),
      });
    }

    this.tools.set(tool.name, tool);
    if (this.pendingRemoved.has(tool.name)) {
      this.enabled.delete(tool.name);
      this.disabled.delete(tool.name);
    } else if (this.pendingDisabled.has(tool.name)) {
      this.enabled.delete(tool.name);
      this.disabled.add(tool.name);
    } else {
      this.enabled.add(tool.name);  // 默认启用
      this.disabled.delete(tool.name);
    }
    if (source) {
      this.sources.set(tool.name, source);
    }
    return this;
  }

  /**
   * 禁用工具（LLM 可见，但执行时会被拦截）
   */
  disable(name: string): boolean {
    this.pendingDisabled.add(name);
    this.pendingRemoved.delete(name);
    if (!this.tools.has(name)) {
      return true;
    }
    this.enabled.delete(name);
    this.disabled.add(name);
    return true;
  }

  /**
   * 启用工具
   */
  enable(name: string): boolean {
    this.pendingDisabled.delete(name);
    this.pendingRemoved.delete(name);
    this.disabled.delete(name);
    if (this.tools.has(name)) {
      this.enabled.add(name);
      return true;
    }
    return false;
  }

  /**
   * 移除工具（LLM 不可见，承接旧 disable 行为）
   */
  remove(name: string): boolean {
    this.pendingRemoved.add(name);
    this.pendingDisabled.delete(name);
    this.disabled.delete(name);
    if (!this.tools.has(name)) {
      return true;
    }
    this.enabled.delete(name);
    return true;
  }

  /**
   * 取消移除工具，恢复为启用状态
   */
  unremove(name: string): boolean {
    return this.enable(name);
  }

  /**
   * 检查工具是否启用
   */
  isEnabled(name: string): boolean {
    return this.enabled.has(name);
  }

  /**
   * 检查工具是否禁用（屏蔽）
   */
  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  /**
   * 检查工具是否移除
   */
  isRemoved(name: string): boolean {
    return this.tools.has(name) && !this.enabled.has(name) && !this.disabled.has(name);
  }

  /**
   * 检查工具是否为 exclusive 模式
   */
  isExclusive(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.executionMode === 'exclusive';
  }

  /**
   * 获取工具来源（调试用）
   */
  getSource(name: string): string | undefined {
    return this.sources.get(name);
  }

  /**
   * 获取工具条目（调试快照用）
   */
  getEntries(): Array<{ tool: Tool; state: 'enabled' | 'disabled' | 'removed' | 'superseded'; enabled: boolean; source?: string }> {
    const entries: Array<{ tool: Tool; state: 'enabled' | 'disabled' | 'removed' | 'superseded'; enabled: boolean; source?: string }> =
      Array.from(this.tools.entries()).map(([name, tool]) => ({
        tool,
        state: this.enabled.has(name) ? 'enabled' : this.disabled.has(name) ? 'disabled' : 'removed',
        enabled: this.enabled.has(name),
        source: this.sources.get(name),
      }));

    // 追加被同名覆盖的旧条目
    for (const [, list] of this.superseded) {
      for (const { tool, source } of list) {
        entries.push({ tool, state: 'superseded', enabled: false, source });
      }
    }

    return entries;
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有 LLM 可见工具（启用 + 禁用）
   */
  getAll(): Tool[] {
    return Array.from(new Set([...this.enabled, ...this.disabled]))
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
