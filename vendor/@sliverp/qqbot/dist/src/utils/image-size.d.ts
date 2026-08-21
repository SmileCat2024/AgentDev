/**
 * 图片尺寸工具
 * 用于获取图片尺寸，生成 QQBot 的 markdown 图片格式
 *
 * QQBot markdown 图片格式: ![#宽px #高px](url)
 */
import { Buffer } from "buffer";
export interface ImageSize {
    width: number;
    height: number;
}
/** 默认图片尺寸（当无法获取时使用） */
export declare const DEFAULT_IMAGE_SIZE: ImageSize;
/**
 * 从图片数据 Buffer 解析尺寸
 */
export declare function parseImageSize(buffer: Buffer): ImageSize | null;
/**
 * 从公网 URL 获取图片尺寸
 * 只下载前 64KB 数据，足够解析大部分图片格式的头部
 */
export declare function getImageSizeFromUrl(url: string, timeoutMs?: number): Promise<ImageSize | null>;
/**
 * 从 Base64 Data URL 获取图片尺寸
 */
export declare function getImageSizeFromDataUrl(dataUrl: string): ImageSize | null;
/**
 * 获取图片尺寸（自动判断来源）
 * @param source - 图片 URL 或 Base64 Data URL
 * @returns 图片尺寸，失败返回 null
 */
export declare function getImageSize(source: string): Promise<ImageSize | null>;
/**
 * 生成 QQBot markdown 图片格式
 * 格式: ![#宽px #高px](url)
 *
 * @param url - 图片 URL
 * @param size - 图片尺寸，如果为 null 则使用默认尺寸
 * @returns QQBot markdown 图片字符串
 */
export declare function formatQQBotMarkdownImage(url: string, size: ImageSize | null): string;
/**
 * 检查 markdown 图片是否已经包含 QQBot 格式的尺寸信息
 * 格式: ![#宽px #高px](url)
 */
export declare function hasQQBotImageSize(markdownImage: string): boolean;
/**
 * 从已有的 QQBot 格式 markdown 图片中提取尺寸
 * 格式: ![#宽px #高px](url)
 */
export declare function extractQQBotImageSize(markdownImage: string): ImageSize | null;
