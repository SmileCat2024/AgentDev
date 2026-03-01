/**
 * 提示词模板系统 - 核心类型定义
 */

/**
 * 模板源
 * - string: 硬编码字符串
 * - { file: string }: 文件路径
 * - [dataSourceName: string]: 数据源名称（如 skills, tasks 等）
 * - TemplateComposer: 组合模板
 *
 * @example
 * ```typescript
 * // 静态字符串
 * 'Hello {{name}}'
 *
 * // 文件
 * { file: 'prompts/system.md' }
 *
 * // 数据源（列表渲染）
 * { skills: '- **{{name}}**: {{description}}' }
 * { tasks: '- [{{title}}](#{{id}}) ({{priority}})' }
 *
 * // 条件渲染
 * { conditional: { part: { file: 'advanced.md' }, condition: (ctx) => ctx.advanced } }
 * ```
 */
export type TemplateSource =
  | string
  | { file: string }
  | { conditional: ConditionalSource }
  | { [dataSourceName: string]: string }  // 数据源 -> 模板
  | import('./composer.js').TemplateComposer;

/**
 * 条件源配置
 */
export interface ConditionalSource {
  /** 条件模板源 */
  part: TemplateSource;
  /** 条件函数（true 时渲染） */
  condition: (context: PlaceholderContext) => boolean;
}

/**
 * 占位符上下文 - 变量替换的键值对
 * 支持原始类型和复杂对象（用于数据源渲染）
 */
export type PlaceholderContext = Record<string, string | number | boolean | undefined | object>;

/**
 * 模板渲染结果
 */
export interface TemplateResult {
  /** 渲染后的内容 */
  content: string;
  /** 使用的源文件列表（用于调试） */
  sources: string[];
}

/**
 * 模板加载器配置
 */
export interface TemplateLoaderOptions {
  /** 缓存启用状态，默认 true */
  cacheEnabled?: boolean;
  /** 模板搜索目录（相对于项目根目录） */
  searchDirs?: string[];
  /** 项目根目录（自动检测） */
  projectRoot?: string;
}

/**
 * 缓存统计
 */
export interface CacheStats {
  size: number;      // 缓存条目数
  hits: number;      // 命中次数
  misses: number;    // 未命中次数
  hitRate: number;   // 命中率
}

/**
 * 模板相关错误
 */
export class TemplateError extends Error {
  constructor(
    message: string,
    public code:
      | 'FILE_NOT_FOUND'
      | 'INVALID_PATH'
      | 'READ_ERROR'
      | 'UNSUPPORTED_FORMAT',
    public path?: string
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}
