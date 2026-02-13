/**
 * 提示词模板系统
 */

// 类型定义
export type {
  TemplateSource,
  PlaceholderContext,
  TemplateResult,
  TemplateLoaderOptions,
  CacheStats,
} from './types.js';

export { TemplateError } from './types.js';

// 核心组件
export { TemplateLoader } from './loader.js';
export { PlaceholderResolver } from './resolver.js';
export { TemplateComposer } from './composer.js';
