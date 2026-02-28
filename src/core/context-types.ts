/**
 * ContextFeature 类型定义
 *
 * @deprecated ContextFeature 已内核化为 Context 类的原生能力
 * 此文件保留仅为向后兼容，将在未来版本中移除。
 *
 * 迁移指南：
 * - 类型定义已移至 src/core/types.ts
 * - Context 类现在自带消息包装和查询能力
 *
 * 请使用以下导入代替：
 * ```typescript
 * import type { MessageTag, ParsedContent, EnrichedMessage, MessageMeta } from './types.js';
 * ```
 */

import type { Message } from './types.js';

// ========== 重导出类型（保持向后兼容） ==========

/**
 * @deprecated 使用 src/core/types.ts 中的 MessageTag
 */
export type { MessageTag } from './types.js';

/**
 * @deprecated 使用 src/core/types.ts 中的 ParsedContent
 */
export type { ParsedContent } from './types.js';

/**
 * @deprecated 使用 src/core/types.ts 中的 EnrichedMessage
 */
export type { EnrichedMessage } from './types.js';

/**
 * @deprecated 使用 src/core/types.ts 中的 MessageMeta
 */
export type { MessageMeta } from './types.js';

// ========== 保留的 ContextFeature 专用类型 ==========

/**
 * Feed 元数据（ContextFeature.feed() 参数）
 *
 * @deprecated 使用 MessageMeta 代替
 */
export interface FeedMetadata {
  /** ReAct 循环轮次 */
  turn: number;
  /** 子代理 ID（子代理消息时填写） */
  agentId?: string;
  /** 来源 Feature（reminder 等消息时填写） */
  source?: string;
}

/**
 * ContextFeature 配置
 */
export interface ContextFeatureConfig {
  /** 是否启用调试日志 */
  debug?: boolean;
}

// ========== 前向声明 ==========

/**
 * @deprecated 使用 Context 类代替
 */
export type { ContextFeature } from '../features/context.js';
