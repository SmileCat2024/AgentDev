/**
 * 本地图床服务器
 * 提供安全的图片存储和访问服务
 */
export interface ImageServerConfig {
    /** 监听端口 */
    port: number;
    /** 图片存储目录 */
    storageDir: string;
    /** 外部访问的基础 URL（如 http://your-server:port），留空则自动生成 */
    baseUrl?: string;
    /** 图片过期时间（秒），0 表示不过期 */
    ttlSeconds?: number;
    /** 允许的图片格式 */
    allowedFormats?: string[];
}
/**
 * 启动图床服务器
 */
export declare function startImageServer(config?: Partial<ImageServerConfig>): Promise<string>;
/**
 * 停止图床服务器
 */
export declare function stopImageServer(): Promise<void>;
/**
 * 保存图片并返回访问 URL
 * @param imageData 图片数据（Buffer 或 base64 字符串）
 * @param mimeType 图片 MIME 类型
 * @param ttlSeconds 过期时间（秒），默认使用配置值
 * @returns 图片访问 URL
 */
export declare function saveImage(imageData: Buffer | string, mimeType?: string, ttlSeconds?: number): string;
/**
 * 从本地文件路径保存图片到图床
 * @param filePath 本地文件路径
 * @param ttlSeconds 过期时间（秒），默认使用配置值
 * @returns 图片访问 URL，如果文件不存在或不是图片则返回 null
 */
export declare function saveImageFromPath(filePath: string, ttlSeconds?: number): string | null;
/**
 * 检查图床服务器是否运行中
 */
export declare function isImageServerRunning(): boolean;
/**
 * 确保图床服务器正在运行
 * 如果未运行，则自动启动
 * @param publicBaseUrl 公网访问的基础 URL（如 http://your-server:18765）
 * @returns 基础 URL，启动失败返回 null
 */
export declare function ensureImageServer(publicBaseUrl?: string): Promise<string | null>;
/**
 * 下载远程文件并保存到本地
 * @param url 远程文件 URL
 * @param destDir 目标目录
 * @param originalFilename 原始文件名（可选，完整文件名包含扩展名）
 * @returns 本地文件路径，失败返回 null
 */
export declare function downloadFile(url: string, destDir: string, originalFilename?: string): Promise<string | null>;
/**
 * 获取图床服务器配置
 */
export declare function getImageServerConfig(): Required<ImageServerConfig>;
