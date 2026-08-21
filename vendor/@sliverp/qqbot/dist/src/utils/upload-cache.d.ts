/**
 * file_info 缓存 — 借鉴 Telegram file_id 机制
 *
 * QQ Bot API 上传文件后返回 file_info + ttl，在 TTL 内相同文件可直接复用 file_info
 * 避免重复上传同一文件，节省带宽和时间。
 *
 * 缓存 key = md5(fileContent) + targetType(c2c/group) + targetId + fileType
 */
/**
 * 计算文件内容的 MD5 hash（用于缓存 key）
 * 对于 Base64 数据直接 hash，对于文件路径读取后 hash
 */
export declare function computeFileHash(data: string | Buffer): string;
/**
 * 从缓存获取 file_info
 * @returns file_info 字符串，未命中或已过期返回 null
 */
export declare function getCachedFileInfo(contentHash: string, scope: "c2c" | "group", targetId: string, fileType: number): string | null;
/**
 * 将上传结果写入缓存
 * @param ttl - API 返回的 TTL（秒），缓存会提前 60 秒失效
 */
export declare function setCachedFileInfo(contentHash: string, scope: "c2c" | "group", targetId: string, fileType: number, fileInfo: string, fileUuid: string, ttl: number): void;
/**
 * 获取缓存统计
 */
export declare function getUploadCacheStats(): {
    size: number;
    maxSize: number;
};
/**
 * 清除所有缓存
 */
export declare function clearUploadCache(): void;
