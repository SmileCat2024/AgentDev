/**
 * QQBot 结构化消息载荷工具
 *
 * 用于处理 AI 输出的结构化消息载荷，包括：
 * - 定时提醒载荷 (cron_reminder)
 * - 媒体消息载荷 (media)
 */
/**
 * 定时提醒载荷
 */
export interface CronReminderPayload {
    type: 'cron_reminder';
    /** 提醒内容 */
    content: string;
    /** 目标类型：c2c (私聊) 或 group (群聊) */
    targetType: 'c2c' | 'group';
    /** 目标地址：user_openid 或 group_openid */
    targetAddress: string;
    /** 原始消息 ID（可选） */
    originalMessageId?: string;
}
/**
 * 媒体消息载荷
 */
export interface MediaPayload {
    type: 'media';
    /** 媒体类型：image, audio, video, file */
    mediaType: 'image' | 'audio' | 'video' | 'file';
    /** 来源类型：url 或 file */
    source: 'url' | 'file';
    /** 媒体路径或 URL */
    path: string;
    /** 媒体描述（可选） */
    caption?: string;
}
/**
 * QQBot 载荷联合类型
 */
export type QQBotPayload = CronReminderPayload | MediaPayload;
/**
 * 解析结果
 */
export interface ParseResult {
    /** 是否为结构化载荷 */
    isPayload: boolean;
    /** 解析后的载荷对象（如果是结构化载荷） */
    payload?: QQBotPayload;
    /** 原始文本（如果不是结构化载荷） */
    text?: string;
    /** 解析错误信息（如果解析失败） */
    error?: string;
}
/**
 * 解析 AI 输出的结构化载荷
 *
 * 检测消息是否以 QQBOT_PAYLOAD: 前缀开头，如果是则提取并解析 JSON
 *
 * @param text AI 输出的原始文本
 * @returns 解析结果
 *
 * @example
 * const result = parseQQBotPayload('QQBOT_PAYLOAD:\n{"type": "media", "mediaType": "image", ...}');
 * if (result.isPayload && result.payload) {
 *   // 处理结构化载荷
 * }
 */
export declare function parseQQBotPayload(text: string): ParseResult;
/**
 * 将定时提醒载荷编码为 Cron 消息格式
 *
 * 将 JSON 编码为 Base64，并添加 QQBOT_CRON: 前缀
 *
 * @param payload 定时提醒载荷
 * @returns 编码后的消息字符串，格式为 QQBOT_CRON:{base64}
 *
 * @example
 * const message = encodePayloadForCron({
 *   type: 'cron_reminder',
 *   content: '喝水时间到！',
 *   targetType: 'c2c',
 *   targetAddress: 'user_openid_xxx'
 * });
 * // 返回: QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs...
 */
export declare function encodePayloadForCron(payload: CronReminderPayload): string;
/**
 * 解码 Cron 消息中的载荷
 *
 * 检测 QQBOT_CRON: 前缀，解码 Base64 并解析 JSON
 *
 * @param message Cron 触发时收到的消息
 * @returns 解码结果，包含是否为 Cron 载荷、解析后的载荷对象或错误信息
 *
 * @example
 * const result = decodeCronPayload('QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs...');
 * if (result.isCronPayload && result.payload) {
 *   // 处理定时提醒
 * }
 */
export declare function decodeCronPayload(message: string): {
    isCronPayload: boolean;
    payload?: CronReminderPayload;
    error?: string;
};
/**
 * 判断载荷是否为定时提醒类型
 */
export declare function isCronReminderPayload(payload: QQBotPayload): payload is CronReminderPayload;
/**
 * 判断载荷是否为媒体消息类型
 */
export declare function isMediaPayload(payload: QQBotPayload): payload is MediaPayload;
