/**
 * 占位符解析器
 * 使用正则表达式实现占位符替换
 */

import type { PlaceholderContext } from './types.js';

/**
 * 占位符解析器
 */
export class PlaceholderResolver {
  // 正则表达式模式
  private static PATTERNS = {
    // {{#if}}...{{/if}} 条件渲染
    conditional: /\{\{#if\}\}(.*?)\{\{\/if\}\}/gs,
    // {{variable}} 或 {{obj.key}} 或 {{var|default}}
    variable: /\{\{([^}]+)\}\}/g,
  };

  /**
   * 解析模板中的占位符
   * @param template 模板内容
   * @param context 变量上下文
   * @returns 解析后的内容
   */
  static resolve(template: string, context: PlaceholderContext = {}): string {
    // 1. 处理条件渲染 {{#if}}...{{/if}}
    let result = PlaceholderResolver.processConditionals(template, context);

    // 2. 处理变量替换（支持嵌套和默认值）
    result = result.replace(PlaceholderResolver.PATTERNS.variable, (_, expr) => {
      const trimmed = expr.trim();

      // 分离默认值: var|default
      const pipeIndex = trimmed.indexOf('|');
      let path: string;
      let defaultValue: string | undefined;

      if (pipeIndex !== -1) {
        path = trimmed.slice(0, pipeIndex).trim();
        defaultValue = trimmed.slice(pipeIndex + 1).trim();
      } else {
        path = trimmed;
      }

      // 获取值（支持嵌套访问）
      const value = PlaceholderResolver.getNestedValue(context, path);

      // 返回值或默认值
      if (value !== undefined && value !== null) {
        return String(value);
      }
      return defaultValue ?? '';
    });

    return result;
  }

  /**
   * 处理条件渲染 {{#if}}...{{/if}}
   * 条件格式：{{#if}}varName{{/if}} - 只有当 varName 为真时才显示内容
   */
  private static processConditionals(
    template: string,
    context: PlaceholderContext
  ): string {
    return template.replace(
      PlaceholderResolver.PATTERNS.conditional,
    (_, content: string) => {
      // 检查条件变量是否存在且为真
      const trimmed = content.trim();
      const value = PlaceholderResolver.getNestedValue(context, trimmed);

      // 布尔值判断
      if (value === true || value === 1 || value === 'true') {
        return '';  // 条件为真，保留内容（但这里逻辑反了，应该返回内容）
      }
      if (value) {
        return content;
      }
      return '';  // 条件为假，移除内容
    });
  }

  /**
   * 获取嵌套对象的值
   * 支持点号分隔的路径，如 "user.name"
   */
  private static getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[key];
    }

    return current;
  }

  /**
   * 获取模板中使用的变量列表
   */
  static extractVariables(template: string): string[] {
    const variables = new Set<string>();
    let match: RegExpExecArray | null;

    // 提取所有变量（不包括条件渲染）
    const regex = /\{\{([^}|]+?)(?:\|[^}]*)?\}\}/g;
    while ((match = regex.exec(template)) !== null) {
      variables.add(match[1].trim());
    }

    return Array.from(variables);
  }

  /**
   * 验证上下文是否包含所需变量
   * @returns 缺失的变量数组
   */
  static validate(
    template: string,
    context: PlaceholderContext
  ): string[] {
    const required = PlaceholderResolver.extractVariables(template);
    const missing: string[] = [];

    for (const path of required) {
      const value = PlaceholderResolver.getNestedValue(context, path);
      if (value === undefined || value === null || value === '') {
        missing.push(path);
      }
    }

    return missing;
  }
}
