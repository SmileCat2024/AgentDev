/**
 * 提示词模板系统 - 核心类型定义
 */

/**
 * 模板源
 * - string: 硬编码字符串
 * - { file: string }: 文件路径
 * - TemplateComposer: 组合模板
 */
export type TemplateSource = string | { file: string } | import('./composer.js').TemplateComposer;

/**
 * 占位符上下文 - 变量替换的键值对
 */
export type PlaceholderContext = Record<string, string | number | boolean | undefined>;

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
