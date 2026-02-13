/**
 * 占位符替换引擎
 *
 * 支持语法：
 * - {{variable}} 基础变量替换
 * - {{user.name}} 嵌套对象访问（点号分隔）
 * - {{variable|default}} 默认值支持
 * - {{#if condition}}...{{/if}} 条件渲染
 *
 * 设计原则：
 * - 最简实现，使用正则表达式，不实现完整模板引擎
 * - 只覆盖核心场景
 * - 条件渲染优先于变量替换（避免内部变量被误解析）
 */

/**
 * 嵌套属性路径解析
 * @example getNestedValue({a: {b: 1}}, 'a.b') => 1
 */
export function getNestedValue(obj: any, path: string): any {
  if (!path) return obj;
  const keys = path.split('.');
  let result = obj;
  for (const key of keys) {
    if (result == null) return undefined;
    result = result[key];
  }
  return result;
}

/**
 * 条件表达式求值
 * 支持简单的真值判断
 * @example evaluateCondition({show: true}, 'show') => true
 * @example evaluateCondition({show: false}, 'show') => false
 * @example evaluateCondition({user: null}, 'user') => false
 */
export function evaluateCondition(context: Record<string, any>, expression: string): boolean {
  const value = getNestedValue(context, expression.trim());
  // 真值判断：非 null、非 undefined、非 false、非空字符串
  return value != null && value !== false && value !== '';
}

/**
 * 占位符替换器类
 */
export class PlaceholderResolver {
  private context: Record<string, any>;

  // 正则表达式模式
  private static readonly CONDITIONAL_PATTERN = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
  private static readonly VARIABLE_PATTERN = /\{\{([^}|]+)(?:\|([^}]*))?\}\}/g;

  constructor(context: Record<string, any> = {}) {
    this.context = context;
  }

  /**
   * 解析模板并替换所有占位符
   * @param template 模板字符串
   * @returns 替换后的字符串
   */
  resolve(template: string): string {
    // 第一步：处理条件渲染（优先处理，避免内部变量被误解析）
    let result = this.processConditionals(template);

    // 第二步：处理变量替换
    result = this.processVariables(result);

    return result;
  }

  /**
   * 处理条件渲染块 {{#if}}...{{/if}}
   */
  private processConditionals(template: string): string {
    return template.replace(
      PlaceholderResolver.CONDITIONAL_PATTERN,
      (_, expression: string, content: string) => {
        const shouldShow = evaluateCondition(this.context, expression);
        return shouldShow ? content : '';
      }
    );
  }

  /**
   * 处理变量替换 {{path|default}}
   */
  private processVariables(template: string): string {
    return template.replace(
      PlaceholderResolver.VARIABLE_PATTERN,
      (_, path: string, defaultValue: string | undefined) => {
        const trimmedPath = path.trim();
        const value = getNestedValue(this.context, trimmedPath);

        // 如果值存在且不是 undefined，返回值
        if (value !== undefined) {
          return String(value);
        }

        // 否则返回默认值（如果有）或空字符串
        return defaultValue !== undefined ? defaultValue : '';
      }
    );
  }

  /**
   * 更新或添加上下文数据
   */
  setContext(key: string, value: any): void;
  setContext(data: Record<string, any>): void;
  setContext(keyOrData: string | Record<string, any>, value?: any): void {
    if (typeof keyOrData === 'string') {
      this.context[keyOrData] = value;
    } else {
      this.context = { ...this.context, ...keyOrData };
    }
  }

  /**
   * 获取当前上下文
   */
  getContext(): Record<string, any> {
    return { ...this.context };
  }

  /**
   * 重置上下文
   */
  resetContext(): void {
    this.context = {};
  }
}

/**
 * 快捷函数：单次模板解析
 * @example
 * resolveTemplate('Hello {{name}}', {name: 'World'}) => 'Hello World'
 */
export function resolveTemplate(
  template: string,
  context: Record<string, any>
): string {
  const resolver = new PlaceholderResolver(context);
  return resolver.resolve(template);
}
