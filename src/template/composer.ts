/**
 * 模板组合器
 * 支持流式 API 和灵活拼接
 */

import type { TemplateSource, PlaceholderContext, TemplateResult } from './types.js';
import { TemplateLoader } from './loader.js';
import { PlaceholderResolver } from './resolver.js';

/**
 * 模板片段类型
 */
type TemplatePart =
  | { type: 'static'; value: string }
  | { type: 'file'; path: string }
  | { type: 'composer'; composer: TemplateComposer }
  | { type: 'conditional'; condition: (ctx: PlaceholderContext) => boolean; part: TemplatePart };

/**
 * 模板组合器
 */
export class TemplateComposer {
  private parts: TemplatePart[] = [];
  private separator: string = '';
  private loader: TemplateLoader;

  constructor(loader?: TemplateLoader) {
    this.loader = loader ?? new TemplateLoader();
  }

  // ========== 核心拼接 API ==========

  /**
   * 添加模板源
   */
  add(source: TemplateSource | TemplateComposer): this {
    this.parts.push(this.toPart(source));
    return this;
  }

  /**
   * 添加模板源（别名）
   */
  append(source: TemplateSource | TemplateComposer): this {
    return this.add(source);
  }

  /**
   * 在头部插入
   */
  prepend(source: TemplateSource | TemplateComposer): this {
    this.parts.unshift(this.toPart(source));
    return this;
  }

  /**
   * 添加多个模板源
   */
  addAll(...sources: (TemplateSource | TemplateComposer)[]): this {
    for (const source of sources) {
      this.add(source);
    }
    return this;
  }

  // ========== 分隔符控制 ==========

  /**
   * 设置分隔符
   */
  joinWith(sep: string): this {
    this.separator = sep;
    return this;
  }

  // ========== 条件拼接 ==========

  /**
   * 条件添加
   */
  when(
    condition: boolean | ((ctx: PlaceholderContext) => boolean),
    source: TemplateSource | TemplateComposer
  ): this {
    const testFn = typeof condition === 'function' ? condition : () => condition;
    this.parts.push({
      type: 'conditional',
      condition: testFn,
      part: this.toPart(source),
    });
    return this;
  }

  /**
   * 条件分支（三目运算语法糖）
   */
  either(
    condition: boolean | ((ctx: PlaceholderContext) => boolean),
    trueSource: TemplateSource | TemplateComposer,
    falseSource?: TemplateSource | TemplateComposer
  ): this {
    this.when(condition, trueSource);
    if (falseSource) {
      this.when(
        typeof condition === 'function'
          ? (ctx) => !condition(ctx)
          : !condition,
        falseSource
      );
    }
    return this;
  }

  // ========== 嵌套组合 ==========

  /**
   * 嵌套子组合器
   */
  nest(composer: TemplateComposer): this {
    this.parts.push({ type: 'composer', composer });
    return this;
  }

  /**
   * 条件嵌套
   */
  nestIf(
    condition: boolean | ((ctx: PlaceholderContext) => boolean),
    composer: TemplateComposer
  ): this {
    return this.when(condition, composer);
  }

  // ========== 工具方法 ==========

  /**
   * 清空所有模板
   */
  clear(): this {
    this.parts = [];
    this.separator = '';
    return this;
  }

  /**
   * 获取当前模板数量
   */
  get size(): number {
    return this.parts.length;
  }

  /**
   * 获取所有模板源
   */
  getSources(): TemplateSource[] {
    return this.parts.map((p) => {
      switch (p.type) {
        case 'static':
          return p.value;
        case 'file':
          return { file: p.path };
        case 'composer':
        case 'conditional':
          return '';
      }
    });
  }

  // ========== 渲染 API ==========

  /**
   * 渲染最终模板
   */
  async render(context: PlaceholderContext = {}): Promise<TemplateResult> {
    const sources: string[] = [];
    const fragments: string[] = [];

    for (const part of this.parts) {
      // 处理条件片段
      if (part.type === 'conditional') {
        if (!part.condition(context)) {
          continue;
        }
        const content = await this.renderPart(part.part, context, sources);
        fragments.push(content);
        continue;
      }

      // 渲染普通片段
      const content = await this.renderPart(part, context, sources);
      fragments.push(content);
    }

    // 用分隔符拼接
    const content = fragments.join(this.separator);

    return { content, sources };
  }

  /**
   * 渲染单个片段
   */
  private async renderPart(
    part: TemplatePart,
    context: PlaceholderContext,
    sources: string[]
  ): Promise<string> {
    switch (part.type) {
      case 'static':
        // 静态字符串，替换占位符
        return PlaceholderResolver.resolve(part.value, context);

      case 'file':
        sources.push(part.path);
        // 从文件加载，然后替换占位符
        const fileContent = await this.loader.load(part.path);
        return PlaceholderResolver.resolve(fileContent, context);

      case 'composer':
        // 嵌套组合器，递归渲染
        const result = await part.composer.render(context);
        sources.push(...result.sources);
        return result.content;

      case 'conditional':
        // 不会到这里，已在 render 中处理
        return '';
    }
  }

  /**
   * 转换为 TemplatePart
   */
  private toPart(source: TemplateSource | TemplateComposer): TemplatePart {
    if (typeof source === 'string') {
      return { type: 'static', value: source };
    }

    if (source instanceof TemplateComposer) {
      return { type: 'composer', composer: source };
    }

    // { file: string }
    return { type: 'file', path: source.file };
  }
}
