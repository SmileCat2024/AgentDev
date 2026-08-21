/**
 * 文件操作工具 — 异步读取 + 大小校验 + 进度提示
 */
/** QQ Bot API 最大上传文件大小：20MB */
export declare const MAX_UPLOAD_SIZE: number;
/** 大文件阈值（超过此值发送进度提示）：5MB */
export declare const LARGE_FILE_THRESHOLD: number;
/**
 * 文件大小校验结果
 */
export interface FileSizeCheckResult {
    ok: boolean;
    size: number;
    error?: string;
}
/**
 * 校验文件大小是否在上传限制内
 * @param filePath 文件路径
 * @param maxSize 最大允许大小（字节），默认 20MB
 */
export declare function checkFileSize(filePath: string, maxSize?: number): FileSizeCheckResult;
/**
 * 异步读取文件内容
 * 替代 fs.readFileSync，避免阻塞事件循环
 */
export declare function readFileAsync(filePath: string): Promise<Buffer>;
/**
 * 异步检查文件是否存在
 */
export declare function fileExistsAsync(filePath: string): Promise<boolean>;
/**
 * 异步获取文件大小
 */
export declare function getFileSizeAsync(filePath: string): Promise<number>;
/**
 * 判断文件是否为"大文件"（需要进度提示）
 */
export declare function isLargeFile(sizeBytes: number): boolean;
/**
 * 格式化文件大小为人类可读的字符串
 */
export declare function formatFileSize(bytes: number): string;
/**
 * 根据文件扩展名获取 MIME 类型
 */
export declare function getMimeType(filePath: string): string;
