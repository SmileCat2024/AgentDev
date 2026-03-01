/**
 * 数据源注册系统
 *
 * 提供通用的列表数据渲染能力，Feature 可以注册自定义数据源
 * 然后在 TemplateComposer 中使用 `{ dataSourceName: 'template' }` 语法
 *
 * @example
 * ```typescript
 * // 注册数据源
 * DataSourceRegistry.register({
 *   name: 'tasks',
 *   getData: async () => [{ id: 1, title: 'Task 1', priority: 'high' }],
 *   renderItem: (item, template, ctx) => {
 *     return PlaceholderResolver.resolve(template, { ...ctx, ...item });
 *   },
 * });
 *
 * // 在模板中使用
 * composer.add({ tasks: '- {{title}} ({{priority}})' });
 * ```
 */

import type { PlaceholderContext } from './types.js';
import { PlaceholderResolver } from './resolver.js';

/**
 * 数据源渲染器接口
 */
export interface DataSourceRenderer<T = any> {
  /** 数据源唯一标识 */
  name: string;

  /**
   * 获取数据列表
   * @param context 渲染上下文
   * @returns 数据数组（可以是异步的）
   */
  getData(context: PlaceholderContext): Promise<T[]> | T[];

  /**
   * 渲染单个数据项
   * @param item 数据项
   * @param template 模板字符串
   * @param context 渲染上下文
   * @returns 渲染后的字符串
   */
  renderItem(item: T, template: string, context: PlaceholderContext): string;

  /**
   * 可选：判断是否启用该数据源
   * @param context 渲染上下文
   * @returns 是否启用（默认 true）
   */
  isEnabled?(context: PlaceholderContext): boolean;
}

/**
 * 数据源注册中心
 */
export class DataSourceRegistry {
  private static sources = new Map<string, DataSourceRenderer>();

  /**
   * 注册数据源
   */
  static register(renderer: DataSourceRenderer): void {
    if (this.sources.has(renderer.name)) {
      console.warn(`[DataSourceRegistry] Data source "${renderer.name}" is being overridden.`);
    }
    this.sources.set(renderer.name, renderer);
  }

  /**
   * 注销数据源
   */
  static unregister(name: string): boolean {
    return this.sources.delete(name);
  }

  /**
   * 获取数据源
   */
  static get(name: string): DataSourceRenderer | undefined {
    return this.sources.get(name);
  }

  /**
   * 检查数据源是否存在
   */
  static has(name: string): boolean {
    return this.sources.has(name);
  }

  /**
   * 获取所有已注册的数据源名称
   */
  static names(): string[] {
    return Array.from(this.sources.keys());
  }

  /**
   * 渲染数据源
   * @param name 数据源名称
   * @param template 模板字符串
   * @param context 渲染上下文
   * @returns 渲染后的字符串
   */
  static async render(
    name: string,
    template: string,
    context: PlaceholderContext = {}
  ): Promise<string> {
    const renderer = this.sources.get(name);

    if (!renderer) {
      console.warn(`[DataSourceRegistry] Unknown data source: "${name}"`);
      return '';
    }

    // 检查是否启用
    if (renderer.isEnabled && !renderer.isEnabled(context)) {
      return '';
    }

    // 获取数据
    const items = await renderer.getData(context);

    if (!items || items.length === 0) {
      return '';
    }

    // 渲染每个项目
    return items.map(item => renderer.renderItem(item, template, context)).join('\n');
  }

  /**
   * 清空所有数据源（主要用于测试）
   */
  static clear(): void {
    this.sources.clear();
  }
}

/**
 * 创建列表渲染器的工厂函数
 * 简化常见数据源的注册
 *
 * @example
 * ```typescript
 * DataSourceRegistry.register(createListRenderer({
 *   name: 'tasks',
 *   getData: (ctx) => ctx.tasks as Task[],
 *   // 默认 renderItem 会将 item 合并到 context 中
 * }));
 * ```
 */
export function createListRenderer<T = any>(
  config: Omit<DataSourceRenderer<T>, 'renderItem'> & {
    /** 自定义渲染函数（可选） */
    renderItem?: DataSourceRenderer<T>['renderItem'];
    /** 是否合并 item 到 context（默认 true） */
    mergeItem?: boolean;
  }
): DataSourceRenderer<T> {
  const { mergeItem = true, renderItem, ...baseConfig } = config;

  return {
    ...baseConfig,
    renderItem: renderItem ?? ((item, template, context) => {
      // 默认行为：将 item 的属性合并到 context 中
      const merged = mergeItem ? (item as Record<string, unknown>) : {};
      const itemContext: PlaceholderContext = {
        ...context,
        ...merged,
        this: item as any,
      };
      return PlaceholderResolver.resolve(template, itemContext);
    }),
  };
}
