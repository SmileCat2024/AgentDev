/**
 * CaptureWorkerPool - 截图 Worker 池（激进策略）
 *
 * 职责：
 * 1. 管理多个截图 Worker（默认 3 个）
 * 2. Worker 空闲时动态查询需要截图的窗口
 * 3. 只负责截图，不负责 LLM 分析
 *
 * 策略：
 * - 激进截图，最小间隔 5 秒
 * - 失去焦点 15 秒后重新获得焦点需要重新截图
 * - 焦点持续 30 秒后需要重新截图
 */

import sharp from 'sharp';
import type { CaptureResult } from './types.js';
import type { WindowState } from './monitor.js';
import { WindowMonitorService } from './monitor.js';
import { VisualCacheManager } from './cache.js';

// ========== 类型定义 ==========

/**
 * 截图 Worker 池配置
 */
export interface CaptureWorkerPoolConfig {
  /** Worker 数量，默认 3 */
  workerCount: number;
  /** Python可执行文件路径 */
  pythonPath: string;
  /** Python参数 */
  pythonArgs?: string[];
}

// ========== 默认配置 ==========

const DEFAULT_CAPTURE_WORKER_CONFIG: Partial<CaptureWorkerPoolConfig> = {
  workerCount: 3,
};

// ========== CaptureWorkerPool 类 ==========

export class CaptureWorkerPool {
  private config: CaptureWorkerPoolConfig;
  private workers: Map<number, Promise<void>> = new Map();
  private shouldStop = false;

  constructor(
    config: CaptureWorkerPoolConfig,
    private monitorService: WindowMonitorService,
    private cacheManager: VisualCacheManager
  ) {
    this.config = { ...DEFAULT_CAPTURE_WORKER_CONFIG, ...config };
  }

  // ========== 生命周期管理 ==========

  /**
   * 启动所有 Worker
   */
  start(): void {
    if (this.workers.size > 0) {
      console.warn('[CaptureWorkerPool] Already started');
      return;
    }

    console.log(`[CaptureWorkerPool] Starting ${this.config.workerCount} capture workers`);

    for (let i = 0; i < this.config.workerCount; i++) {
      const workerPromise = this.workerLoop(i);
      this.workers.set(i, workerPromise);
    }
  }

  /**
   * 停止所有 Worker
   */
  async stop(): Promise<void> {
    console.log('[CaptureWorkerPool] Stopping capture workers');
    this.shouldStop = true;

    // 等待所有 Worker 完成
    const workerPromises = Array.from(this.workers.values());
    await Promise.all(workerPromises);

    this.workers.clear();
    this.shouldStop = false;
    console.log('[CaptureWorkerPool] All capture workers stopped');
  }

  // ========== Worker 工作循环 ==========

  /**
   * Worker 工作循环
   */
  private async workerLoop(workerId: number): Promise<void> {
    console.log(`[CaptureWorker ${workerId}] Started`);

    while (!this.shouldStop) {
      try {
        // 1. 查询当前需要截图的窗口
        const window = this.monitorService.getHighestPriorityWindowForCapture();

        if (!window) {
          // 没有需要截图的窗口，等待 100ms
          await this.sleep(100);
          continue;
        }

        console.log(`[CaptureWorker ${workerId}] Capturing: ${window.hwnd} (Foreground: ${window.isForeground})`);

        // 2. 标记窗口为截图中
        this.monitorService.markCapturing(window.hwnd);

        try {
          // 3. 截图
          await this.captureWindow(workerId, window);
        } finally {
          // 4. 截图完成，标记为未截图中
          this.monitorService.markCaptureDone(window.hwnd);
        }
      } catch (error) {
        console.error(`[CaptureWorker ${workerId}] Loop error:`, error);
        // 等待 1 秒再继续
        await this.sleep(1000);
      }
    }

    console.log(`[CaptureWorker ${workerId}] Stopped`);
  }

  /**
   * 截图窗口
   */
  private async captureWindow(workerId: number, window: WindowState): Promise<void> {
    // 1. 截图
    const capture = await this.safeCaptureWindow(window.hwnd);

    if (!capture || !capture.data) {
      console.warn(`[CaptureWorker ${workerId}] Empty capture for ${window.hwnd}`);
      return;
    }

    // 2. 截图有效性检测
    const validationResult = await this.validateCapture(workerId, window.hwnd, capture);
    if (!validationResult.isValid) {
      console.warn(`[CaptureWorker ${workerId}] Invalid capture for ${window.hwnd}: ${validationResult.reason}`);
      return;
    }

    // 3. 检查是否与上次缓存相同（去重）
    if (await this.isDuplicateCapture(window.hwnd, capture.data!)) {
      console.log(`[CaptureWorker ${workerId}] Duplicate capture for ${window.hwnd}, skipping`);
      return;
    }

    // 4. 保存截图
    const imagePath = await this.cacheManager.saveCapture(
      window.hwnd,
      capture.data!,
      window.title
    );

    console.log(`[CaptureWorker ${workerId}] Captured: ${window.hwnd} (${capture.width}x${capture.height})`);
  }

  // ========== 私有方法：截图 ==========

  /**
   * 安全截图
   */
  private async safeCaptureWindow(hwnd: string): Promise<CaptureResult | null> {
    const { captureWindow } = await import('./tools.js');

    const result = await this.withTimeout(
      captureWindow(hwnd, this.config.pythonPath, this.config.pythonArgs),
      10000,
      'Capture timeout'
    );

    const captureResult = result as CaptureResult;

    if ('error' in captureResult) {
      console.warn(`[CaptureWorker] Capture failed for ${hwnd}:`, captureResult.error);
      return null;
    }

    if (!captureResult.success || !captureResult.data) {
      console.warn(`[CaptureWorker] Capture failed or empty for ${hwnd}`);
      return null;
    }

    // 检查图片尺寸
    if (!captureResult.width || !captureResult.height) {
      console.warn(`[CaptureWorker] Invalid image dimensions for ${hwnd}`);
      return null;
    }

    if (captureResult.width < 10 || captureResult.height < 10) {
      console.warn(`[CaptureWorker] Invalid image size: ${captureResult.width}x${captureResult.height}`);
      return null;
    }

    return captureResult;
  }

  /**
   * 截图有效性检测
   */
  private async validateCapture(
    workerId: number,
    hwnd: string,
    capture: CaptureResult
  ): Promise<{ isValid: boolean; reason?: string }> {
    // 1. 检查最小边长（最短边 >= 200px）
    const minSide = Math.min(capture.width!, capture.height!);
    if (minSide < 200) {
      return { isValid: false, reason: `Min side ${minSide}px < 200px` };
    }

    // 2. 检测纯色图片
    const isSolidColor = await this.detectSolidColor(capture.data!);
    if (isSolidColor) {
      return { isValid: false, reason: 'Solid color image' };
    }

    return { isValid: true };
  }

  /**
   * 检测是否为纯色图片（使用 sharp）
   */
  private async detectSolidColor(base64Image: string): Promise<boolean> {
    try {
      // 解码 base64
      const imageBuffer = Buffer.from(base64Image, 'base64');

      // 获取图片尺寸
      const metadata = await sharp(imageBuffer).metadata();
      const { width, height } = metadata;

      // 采样像素进行纯色检测（避免处理所有像素）
      // 使用 resize 缩小图片，然后统计颜色分布
      const sampleSize = 50; // 缩小到 50x50
      const { data } = await sharp(imageBuffer)
        .resize(sampleSize, sampleSize, { fit: 'cover' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      // data 是 Uint8ClampedArray [r, g, b, a, r, g, b, a, ...]
      const pixelCount = data.length / 4;
      const colorMap = new Map<string, number>();

      // 统计颜色出现次数
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // 忽略 alpha 通道
        const colorKey = `${r},${g},${b}`;
        colorMap.set(colorKey, (colorMap.get(colorKey) || 0) + 1);
      }

      // 找出最频繁的颜色
      let maxCount = 0;
      for (const count of colorMap.values()) {
        if (count > maxCount) {
          maxCount = count;
        }
      }

      // 如果主颜色占比超过 95%，认为是纯色
      const ratio = maxCount / pixelCount;
      return ratio >= 0.95;
    } catch (error) {
      console.warn('[CaptureWorker] Sharp error:', error);
      // 如果 sharp 失败，回退到简单的文件大小检测
      try {
        const imageBuffer = Buffer.from(base64Image, 'base64');
        const sizeThreshold = 5000; // 5KB
        return imageBuffer.length < sizeThreshold;
      } catch {
        return false;
      }
    }
  }

  /**
   * 检查是否与上次缓存相同（去重）
   */
  private async isDuplicateCapture(hwnd: string, base64Image: string): Promise<boolean> {
    const previousCapturePath = this.cacheManager.getLastCapturePath(hwnd);
    if (!previousCapturePath) {
      return false;
    }

    try {
      const { readFileSync } = await import('fs');
      const previousBuffer = readFileSync(previousCapturePath);
      const previousBase64 = previousBuffer.toString('base64');

      // 简单比较：直接比较 base64 字符串
      // 注意：这个方法可能对完全相同的图片有效，但对微小变化不敏感
      return previousBase64 === base64Image;
    } catch {
      return false;
    }
  }

  /**
   * 超时保护
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string = 'Timeout'
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      ),
    ]);
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
