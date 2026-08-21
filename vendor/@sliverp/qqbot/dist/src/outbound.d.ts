/**
 * QQ Bot 消息发送模块
 */
import type { ResolvedQQBotAccount } from "./types.js";
/** 限流检查结果 */
export interface ReplyLimitResult {
    /** 是否允许被动回复 */
    allowed: boolean;
    /** 剩余被动回复次数 */
    remaining: number;
    /** 是否需要降级为主动消息（超期或超过次数） */
    shouldFallbackToProactive: boolean;
    /** 降级原因 */
    fallbackReason?: "expired" | "limit_exceeded";
    /** 提示消息 */
    message?: string;
}
/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns ReplyLimitResult 限流检查结果
 */
export declare function checkMessageReplyLimit(messageId: string): ReplyLimitResult;
/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
export declare function recordMessageReply(messageId: string): void;
/**
 * 获取消息回复统计信息
 */
export declare function getMessageReplyStats(): {
    trackedMessages: number;
    totalReplies: number;
};
/**
 * 获取消息回复限制配置（供外部查询）
 */
export declare function getMessageReplyConfig(): {
    limit: number;
    ttlMs: number;
    ttlHours: number;
};
export interface OutboundContext {
    to: string;
    text: string;
    accountId?: string | null;
    replyToId?: string | null;
    account: ResolvedQQBotAccount;
}
export interface MediaOutboundContext extends OutboundContext {
    mediaUrl: string;
}
export interface OutboundResult {
    channel: string;
    messageId?: string;
    timestamp?: string | number;
    error?: string;
}
/**
 * 发送文本消息
 * - 有 replyToId: 被动回复，1小时内最多回复4次
 * - 无 replyToId: 主动发送，有配额限制（每月4条/用户/群）
 *
 * 注意：
 * 1. 主动消息（无 replyToId）必须有消息内容，不支持流式发送
 * 2. 当被动回复不可用（超期或超过次数）时，自动降级为主动消息
 * 3. 支持 <qqimg>路径</qqimg> 或 <qqimg>路径</img> 格式发送图片
 */
export declare function sendText(ctx: OutboundContext): Promise<OutboundResult>;
/**
 * 主动发送消息（不需要 replyToId，有配额限制：每月 4 条/用户/群）
 *
 * @param account - 账户配置
 * @param to - 目标地址，格式：openid（单聊）或 group:xxx（群聊）
 * @param text - 消息内容
 */
export declare function sendProactiveMessage(account: ResolvedQQBotAccount, to: string, text: string): Promise<OutboundResult>;
/**
 * 发送富媒体消息（图片）
 *
 * 支持以下 mediaUrl 格式：
 * - 公网 URL: https://example.com/image.png
 * - Base64 Data URL: data:image/png;base64,xxxxx
 * - 本地文件路径: /path/to/image.png（自动读取并转换为 Base64）
 *
 * @param ctx - 发送上下文，包含 mediaUrl
 * @returns 发送结果
 *
 * @example
 * ```typescript
 * // 发送网络图片
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "https://example.com/image.png",
 *   account,
 *   replyToId: msgId,
 * });
 *
 * // 发送 Base64 图片
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "data:image/png;base64,iVBORw0KGgo...",
 *   account,
 *   replyToId: msgId,
 * });
 *
 * // 发送本地文件（自动读取并转换为 Base64）
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "/tmp/generated-chart.png",
 *   account,
 *   replyToId: msgId,
 * });
 * ```
 */
export declare function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult>;
/**
 * 发送 Cron 触发的消息
 *
 * 当 OpenClaw cron 任务触发时，消息内容可能是：
 * 1. QQBOT_CRON:{base64} 格式的结构化载荷 - 解码后根据 targetType 和 targetAddress 发送
 * 2. 普通文本 - 直接发送到指定目标
 *
 * @param account - 账户配置
 * @param to - 目标地址（作为后备，如果载荷中没有指定）
 * @param message - 消息内容（可能是 QQBOT_CRON: 格式或普通文本）
 * @returns 发送结果
 *
 * @example
 * ```typescript
 * // 处理结构化载荷
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",  // 后备地址
 *   "QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs..."  // Base64 编码的载荷
 * );
 *
 * // 处理普通文本
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",
 *   "这是一条普通的提醒消息"
 * );
 * ```
 */
export declare function sendCronMessage(account: ResolvedQQBotAccount, to: string, message: string): Promise<OutboundResult>;
