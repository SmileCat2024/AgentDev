/**
 * VisualCacheManager - 视觉缓存管理器
 *
 * 职责：
 * 1. 管理截图和识别结果的文件存储
 * 2. LRU + TTL 动态清理
 * 3. 容量限制防止膨胀
 *
 * 目录结构：
 * .agentdev/
 *   visual-cache/
 *     images/
 *       {hwnd}_{timestamp}.png
 *     analyses/
 *       {hwnd}.json
 *     metadata.json
 */

import { mkdir, writeFile, readFile, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { cwd } from 'process';

// ========== 类型定义 ==========

/**
 * 分析结果
 */
export interface AnalysisResult {
  /** 图片内容的自然语言描述 */
  description: string;
  /** 使用的模型 */
  model: string;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 缓存元数据条目
 */
export interface CacheMetadataEntry {
  /** 窗口句柄 */
  hwnd: string;
  /** 窗口标题 */
  title: string;

  // 截图信息（支持多个截图）
  /** 截图列表（最近5个） */
  captures: Array<{
    /** 截图文件路径 */
    path: string;
    /** 截图文件大小（字节） */
    size: number;
    /** 截图创建时间戳 */
    createdAt: number;
  }>;

  // 分析信息
  /** 分析结果文件路径 */
  analysisPath: string;
  /** 分析结果 */
  analysis: AnalysisResult;

  // 访问统计
  /** 最后访问时间戳 */
  lastAccessAt: number;
  /** 访问次数 */
  accessCount: number;
}

/**
 * 缓存元数据
 */
export interface CacheMetadata {
  /** 版本号 */
  version: string;
  /** 上次清理时间戳 */
  lastCleanup: number;
  /** 总大小（字节） */
  totalSize: number;
  /** 文件数量 */
  count: number;
  /** 缓存条目 */
  entries: Record<string, CacheMetadataEntry>;
}

/**
 * 缓存配置
 */
export interface CacheConfig {
  /** 缓存根目录，默认 .agentdev/visual-cache */
  cacheDir: string;
  /** 最大总大小（字节），默认 500MB */
  maxSize: number;
  /** 最大文件数，默认 100 */
  maxCount: number;
  /** 每个窗口保留的最大截图数量，默认 5 */
  maxCapturesPerWindow: number;
  /** 截图TTL（毫秒），默认 7天 */
  imageTTL: number;
  /** 分析结果TTL（毫秒），默认 7天 */
  analysisTTL: number;
  /** 清理间隔（毫秒），默认 10分钟 */
  cleanupInterval: number;
}

// ========== 默认配置 ==========

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  cacheDir: '.agentdev/visual-cache',
  maxSize: 500 * 1024 * 1024,  // 500MB
  maxCount: 100,
  maxCapturesPerWindow: 5,
  imageTTL: 7 * 24 * 60 * 60 * 1000,  // 7天
  analysisTTL: 7 * 24 * 60 * 60 * 1000,  // 7天（用于磁盘清理）
  cleanupInterval: 10 * 60 * 1000,  // 10分钟
};

// ========== VisualCacheManager 类 ==========

export class VisualCacheManager {
  private config: CacheConfig;
  private cacheRoot: string;
  private imagesDir: string;
  private analysesDir: string;
  private metadataPath: string;
  private metadata: CacheMetadata;
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  constructor(config: Partial<CacheConfig> = {}) {
    // 使用空值合并运算符防止undefined覆盖默认值
    this.config = {
      cacheDir: config.cacheDir ?? DEFAULT_CACHE_CONFIG.cacheDir,
      maxSize: config.maxSize ?? DEFAULT_CACHE_CONFIG.maxSize,
      maxCount: config.maxCount ?? DEFAULT_CACHE_CONFIG.maxCount,
      maxCapturesPerWindow: config.maxCapturesPerWindow ?? DEFAULT_CACHE_CONFIG.maxCapturesPerWindow,
      imageTTL: config.imageTTL ?? DEFAULT_CACHE_CONFIG.imageTTL,
      analysisTTL: config.analysisTTL ?? DEFAULT_CACHE_CONFIG.analysisTTL,
      cleanupInterval: config.cleanupInterval ?? DEFAULT_CACHE_CONFIG.cleanupInterval,
    };
    this.cacheRoot = join(cwd(), this.config.cacheDir);
    this.imagesDir = join(this.cacheRoot, 'images');
    this.analysesDir = join(this.cacheRoot, 'analyses');
    this.metadataPath = join(this.cacheRoot, 'metadata.json');

    // 初始化空元数据
    this.metadata = {
      version: '1.0',
      lastCleanup: 0,
      totalSize: 0,
      count: 0,
      entries: {},
    };
  }

  // ========== 初始化与清理 ==========

  /**
   * 初始化缓存目录和元数据
   */
  async initialize(): Promise<void> {
    console.log(`[VisualCacheManager] Initializing cache at ${this.cacheRoot}`);

    // 创建目录结构
    await this.ensureDirectory(this.cacheRoot);
    await this.ensureDirectory(this.imagesDir);
    await this.ensureDirectory(this.analysesDir);

    // 加载元数据
    await this.loadMetadata();

    // 启动定期清理
    this.startCleanup();
  }

  /**
   * 停止缓存管理器
   */
  async stop(): Promise<void> {
    console.log('[VisualCacheManager] Stopping cache manager');

    // 停止定期清理
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }

    // 保存元数据
    await this.saveMetadata();

    // 执行一次清理
    await this.cleanup();
  }

  /**
   * 清空所有缓存（删除所有缓存文件和元数据）
   */
  async clear(): Promise<void> {
    console.log('[VisualCacheManager] Clearing all cache...');

    try {
      // 1. 删除所有截图文件
      const { readdir, unlink } = await import('fs/promises');
      const imageFiles = await readdir(this.imagesDir).catch(() => []);
      for (const file of imageFiles) {
        const imagePath = join(this.imagesDir, file);
        await unlink(imagePath).catch(err => {
          console.warn(`[VisualCacheManager] Failed to delete image ${imagePath}:`, err);
        });
      }

      // 2. 删除所有分析文件
      const analysisFiles = await readdir(this.analysesDir).catch(() => []);
      for (const file of analysisFiles) {
        const analysisPath = join(this.analysesDir, file);
        await unlink(analysisPath).catch(err => {
          console.warn(`[VisualCacheManager] Failed to delete analysis ${analysisPath}:`, err);
        });
      }

      // 3. 重置元数据
      this.metadata = {
        version: '1.0',
        lastCleanup: 0,
        totalSize: 0,
        count: 0,
        entries: {},
      };

      // 4. 保存清空后的元数据
      await this.saveMetadata();

      console.log('[VisualCacheManager] Cache cleared successfully');
    } catch (error) {
      console.error('[VisualCacheManager] Error clearing cache:', error);
    }
  }

  // ========== 文件操作 ==========

  /**
   * 保存截图
   * @param hwnd 窗口句柄
   * @param base64Image base64编码的图片
   * @param title 窗口标题
   * @returns 截图文件路径
   */
  async saveCapture(hwnd: string, base64Image: string, title: string = ''): Promise<string> {
    const timestamp = Date.now();
    const filename = `${hwnd}_${timestamp}.png`;
    const imagePath = join(this.imagesDir, filename);

    // 将base64转换为Buffer
    const imageBuffer = Buffer.from(base64Image, 'base64');

    // 保存图片
    await writeFile(imagePath, imageBuffer);

    // 更新元数据
    this.updateMetadataForCapture(hwnd, title, imagePath, imageBuffer.length, timestamp);

    console.log(`[VisualCacheManager] Saved capture: ${imagePath} (${imageBuffer.length} bytes)`);

    return imagePath;
  }

  /**
   * 保存分析结果
   * @param hwnd 窗口句柄
   * @param analysis 分析结果
   * @param title 窗口标题（可选，用于更新）
   */
  async saveAnalysis(hwnd: string, analysis: AnalysisResult, title?: string): Promise<void> {
    const filename = `${hwnd}.json`;
    const analysisPath = join(this.analysesDir, filename);

    // 保存分析结果
    await writeFile(analysisPath, JSON.stringify(analysis, null, 2), 'utf-8');

    // 更新元数据
    this.updateMetadataForAnalysis(hwnd, title, analysisPath, analysis);

    console.log(`[VisualCacheManager] Saved analysis: ${analysisPath}`);
  }

  /**
   * 获取截图文件路径（最新的）
   * @param hwnd 窗口句柄
   * @returns 截图文件路径，如果不存在返回null
   */
  getCapturePath(hwnd: string): string | null {
    const entry = this.metadata.entries[hwnd];
    if (!entry || entry.captures.length === 0) return null;

    // 更新访问统计
    entry.lastAccessAt = Date.now();
    entry.accessCount++;

    // 返回最新的截图
    return entry.captures[entry.captures.length - 1].path;
  }

  /**
   * 获取上次截图文件路径（用于去重检测）
   * @param hwnd 窗口句柄
   * @returns 上次截图文件路径，如果不存在返回null
   */
  getLastCapturePath(hwnd: string): string | null {
    const entry = this.metadata.entries[hwnd];
    if (!entry || entry.captures.length === 0) return null;

    // 返回最新的截图
    return entry.captures[entry.captures.length - 1].path;
  }

  /**
   * 获取分析结果
   * @param hwnd 窗口句柄
   * @param ttl 可选的 TTL（毫秒），如果不使用则使用配置中的 TTL
   * @returns 分析结果，如果不存在或已过期返回null
   */
  getAnalysis(hwnd: string, ttl?: number): AnalysisResult | null {
    const entry = this.metadata.entries[hwnd];
    if (!entry) return null;

    // 更新访问统计
    entry.lastAccessAt = Date.now();
    entry.accessCount++;

    // 检查是否过期（使用传入的 TTL 或配置中的 TTL）
    const now = Date.now();
    const age = now - entry.analysis.createdAt;
    const effectiveTTL = ttl ?? this.config.analysisTTL;

    if (age > effectiveTTL) {
      console.warn(`[VisualCacheManager] Analysis expired for ${hwnd} (age: ${Math.round(age / 1000)}s, TTL: ${Math.round(effectiveTTL / 1000)}s)`);
      return null;
    }

    return entry.analysis;
  }

  /**
   * 获取所有缓存条目
   * @returns 所有缓存条目数组
   */
  getAllEntries(): CacheMetadataEntry[] {
    return Object.values(this.metadata.entries);
  }

  /**
   * 获取缓存的窗口列表
   * @returns 窗口句柄数组
   */
  getCachedHwnds(): string[] {
    return Object.keys(this.metadata.entries);
  }

  // ========== 私有方法：元数据管理 ==========

  /**
   * 更新元数据（截图）
   */
  private updateMetadataForCapture(
    hwnd: string,
    title: string,
    imagePath: string,
    imageSize: number,
    timestamp: number
  ): void {
    let entry = this.metadata.entries[hwnd];

    if (!entry) {
      // 创建新条目
      entry = {
        hwnd,
        title,
        captures: [{
          path: imagePath,
          size: imageSize,
          createdAt: timestamp,
        }],
        analysisPath: '',
        analysis: {
          description: '',
          model: '',
          createdAt: 0,
        },
        lastAccessAt: timestamp,
        accessCount: 1,
      };

      this.metadata.entries[hwnd] = entry;
      this.metadata.count++;
      this.metadata.totalSize += imageSize;
    } else {
      // 更新现有条目
      entry.title = title;
      entry.lastAccessAt = timestamp;
      entry.accessCount++;

      // 添加新截图到列表
      entry.captures.push({
        path: imagePath,
        size: imageSize,
        createdAt: timestamp,
      });

      // 更新总大小
      this.metadata.totalSize += imageSize;

      // 清理旧截图（每个窗口保留最近 maxCapturesPerWindow 个）
      this.cleanupOldCaptures(entry);
    }

    // 异步保存元数据
    this.saveMetadata().catch(err => {
      console.error('[VisualCacheManager] Failed to save metadata:', err);
    });
  }

  /**
   * 清理旧截图（每个窗口保留最近 N 个）
   */
  private async cleanupOldCaptures(entry: CacheMetadataEntry): Promise<void> {
    const maxCaptures = this.config.maxCapturesPerWindow;

    if (entry.captures.length <= maxCaptures) {
      return;
    }

    // 需要删除的截图数量
    const toRemove = entry.captures.length - maxCaptures;

    for (let i = 0; i < toRemove; i++) {
      const oldCapture = entry.captures[i];

      try {
        // 删除文件
        const { unlink } = await import('fs/promises');
        await unlink(oldCapture.path);

        // 更新总大小
        this.metadata.totalSize -= oldCapture.size;

        console.log(`[VisualCacheManager] Removed old capture: ${oldCapture.path}`);
      } catch (err) {
        console.warn(`[VisualCacheManager] Failed to delete old capture ${oldCapture.path}:`, err);
      }
    }

    // 更新截图列表（只保留最近 maxCapturesPerWindow 个）
    entry.captures = entry.captures.slice(-maxCaptures);
  }

  /**
   * 更新元数据（分析结果）
   */
  private updateMetadataForAnalysis(
    hwnd: string,
    title: string | undefined,
    analysisPath: string,
    analysis: AnalysisResult
  ): void {
    const entry = this.metadata.entries[hwnd];

    if (entry) {
      if (title) entry.title = title;
      entry.analysisPath = analysisPath;
      entry.analysis = analysis;

      // 异步保存元数据
      this.saveMetadata().catch(err => {
        console.error('[VisualCacheManager] Failed to save metadata:', err);
      });
    }
  }

  /**
   * 加载元数据
   */
  private async loadMetadata(): Promise<void> {
    if (existsSync(this.metadataPath)) {
      try {
        const data = await readFile(this.metadataPath, 'utf-8');
        this.metadata = JSON.parse(data);
        console.log(`[VisualCacheManager] Loaded metadata: ${this.metadata.count} entries, ${this.metadata.totalSize} bytes`);
      } catch (error) {
        console.warn('[VisualCacheManager] Failed to load metadata, creating new one:', error);
        this.metadata = {
          version: '1.0',
          lastCleanup: 0,
          totalSize: 0,
          count: 0,
          entries: {},
        };
      }
    } else {
      console.log('[VisualCacheManager] No existing metadata found, creating new one');
    }
  }

  /**
   * 保存元数据
   */
  private async saveMetadata(): Promise<void> {
    try {
      await writeFile(this.metadataPath, JSON.stringify(this.metadata, null, 2), 'utf-8');
    } catch (error) {
      console.error('[VisualCacheManager] Failed to save metadata:', error);
    }
  }

  // ========== 私有方法：清理逻辑 ==========

  /**
   * 启动定期清理
   */
  private startCleanup(): void {
    this.cleanupIntervalId = setInterval(() => {
      this.cleanup().catch(err => {
        console.error('[VisualCacheManager] Cleanup failed:', err);
      });
    }, this.config.cleanupInterval);

    console.log(`[VisualCacheManager] Started periodic cleanup (interval: ${this.config.cleanupInterval}ms)`);
  }

  /**
   * 执行清理
   */
  async cleanup(): Promise<void> {
    console.log('[VisualCacheManager] Starting cleanup...');

    const now = Date.now();
    let removedCount = 0;

    // 1. 删除过期的文件
    const expiredHwnds = Object.keys(this.metadata.entries).filter(hwnd => {
      const entry = this.metadata.entries[hwnd];
      if (entry.captures.length === 0) return true;

      // 检查最新的截图是否过期
      const latestCapture = entry.captures[entry.captures.length - 1];
      const imageAge = now - latestCapture.createdAt;

      // 检查分析结果是否过期
      const analysisAge = now - entry.analysis.createdAt;

      return imageAge > this.config.imageTTL || analysisAge > this.config.analysisTTL;
    });

    for (const hwnd of expiredHwnds) {
      await this.removeEntry(hwnd);
      removedCount++;
    }

    console.log(`[VisualCacheManager] Removed ${removedCount} expired entries`);

    // 2. 按LRU顺序清理，直到满足容量限制
    const entries = Object.values(this.metadata.entries)
      .sort((a, b) => a.lastAccessAt - b.lastAccessAt);

    let totalSize = this.metadata.totalSize;
    let count = this.metadata.count;

    while ((totalSize > this.config.maxSize || count > this.config.maxCount) && entries.length > 0) {
      const entry = entries.shift()!;
      await this.removeEntry(entry.hwnd);
      removedCount++;
      // 从 totalSize 中减去该条目的所有截图大小
      totalSize -= entry.captures.reduce((sum, cap) => sum + cap.size, 0);
      count--;
    }

    // 3. 更新元数据
    this.metadata.lastCleanup = now;
    await this.saveMetadata();

    console.log(`[VisualCacheManager] Cleanup complete: ${removedCount} entries removed`);
  }

  /**
   * 删除缓存条目
   */
  private async removeEntry(hwnd: string): Promise<void> {
    const entry = this.metadata.entries[hwnd];

    if (!entry) return;

    // 删除所有截图文件
    for (const capture of entry.captures) {
      try {
        const { unlink } = await import('fs/promises');
        await unlink(capture.path);
      } catch (err) {
        console.warn(`[VisualCacheManager] Failed to delete image ${capture.path}:`, err);
      }
    }

    // 删除分析文件
    try {
      const { unlink } = await import('fs/promises');
      if (entry.analysisPath && existsSync(entry.analysisPath)) {
        await unlink(entry.analysisPath);
      }
    } catch (err) {
      console.warn(`[VisualCacheManager] Failed to delete analysis ${entry.analysisPath}:`, err);
    }

    // 删除元数据
    delete this.metadata.entries[hwnd];
    this.metadata.count--;

    // 更新总大小
    this.metadata.totalSize -= entry.captures.reduce((sum, cap) => sum + cap.size, 0);

    console.log(`[VisualCacheManager] Removed cache entry: ${hwnd}`);
  }

  // ========== 私有方法：辅助函数 ==========

  /**
   * 确保目录存在
   */
  private async ensureDirectory(dirPath: string): Promise<void> {
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
      console.log(`[VisualCacheManager] Created directory: ${dirPath}`);
    }
  }
}
