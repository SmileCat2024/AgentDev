/**
 * AnalysisWorkerPool - 分析 Worker 池（保守策略）
 *
 * 职责：
 * 1. 管理多个分析 Worker（默认 2 个）
 * 2. Worker 空闲时动态查询需要分析的窗口
 * 3. 只负责 LLM 分析，不负责截图
 *
 * 策略：
 * - 保守分析，最小间隔 60 秒
 * - 失去焦点 30 秒后重新获得焦点需要重新分析
 * - 焦点持续 60 秒后需要重新分析
 * - 使用已缓存的截图进行分析
 */

import OpenAI from 'openai';
import type { AnalysisResult } from './cache.js';
import type { WindowState } from './monitor.js';
import { WindowMonitorService } from './monitor.js';
import { VisualCacheManager } from './cache.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// ========== 类型定义 ==========

/**
 * 分析 Worker 池配置
 */
export interface AnalysisWorkerPoolConfig {
  /** Worker 数量，默认 2 */
  workerCount: number;
  /** OpenAI客户端 */
  client: OpenAI;
  /** 视觉模型名称 */
  model: string;
  /** 最大重试次数，默认 1 */
  maxRetries: number;
  /** 缓存过期时间（毫秒），用于检查缓存是否有效 */
  analysisTTL?: number;
}

// ========== 默认配置 ==========

const DEFAULT_ANALYSIS_WORKER_CONFIG: Partial<AnalysisWorkerPoolConfig> = {
  workerCount: 2,
  maxRetries: 1,
};

// ========== AnalysisWorkerPool 类 ==========

export class AnalysisWorkerPool {
  private config: AnalysisWorkerPoolConfig;
  private workers: Map<number, Promise<void>> = new Map();
  private shouldStop = false;

  constructor(
    config: AnalysisWorkerPoolConfig,
    private monitorService: WindowMonitorService,
    private cacheManager: VisualCacheManager
  ) {
    this.config = { ...DEFAULT_ANALYSIS_WORKER_CONFIG, ...config };
  }

  // ========== 生命周期管理 ==========

  /**
   * 启动所有 Worker
   */
  start(): void {
    if (this.workers.size > 0) {
      console.warn('[AnalysisWorkerPool] Already started');
      return;
    }

    console.log(`[AnalysisWorkerPool] Starting ${this.config.workerCount} analysis workers`);

    for (let i = 0; i < this.config.workerCount; i++) {
      const workerPromise = this.workerLoop(i);
      this.workers.set(i, workerPromise);
    }
  }

  /**
   * 停止所有 Worker
   */
  async stop(): Promise<void> {
    console.log('[AnalysisWorkerPool] Stopping analysis workers');
    this.shouldStop = true;

    // 等待所有 Worker 完成
    const workerPromises = Array.from(this.workers.values());
    await Promise.all(workerPromises);

    this.workers.clear();
    this.shouldStop = false;
    console.log('[AnalysisWorkerPool] All analysis workers stopped');
  }

  // ========== Worker 工作循环 ==========

  /**
   * Worker 工作循环
   */
  private async workerLoop(workerId: number): Promise<void> {
    console.log(`[AnalysisWorker ${workerId}] Started`);

    while (!this.shouldStop) {
      try {
        // 1. 查询当前需要分析的窗口
        const window = this.monitorService.getHighestPriorityWindowForAnalysis();

        if (!window) {
          // 没有需要分析的窗口，等待 100ms
          await this.sleep(100);
          continue;
        }

        console.log(`[AnalysisWorker ${workerId}] Analyzing: ${window.hwnd} (Foreground: ${window.isForeground})`);

        // 2. 标记窗口为分析中
        this.monitorService.markAnalyzing(window.hwnd);

        try {
          // 3. 分析
          await this.analyzeWindow(workerId, window);
        } finally {
          // 4. 分析完成，标记为未分析中
          this.monitorService.markAnalysisDone(window.hwnd);
        }
      } catch (error) {
        console.error(`[AnalysisWorker ${workerId}] Loop error:`, error);
        // 等待 1 秒再继续
        await this.sleep(1000);
      }
    }

    console.log(`[AnalysisWorker ${workerId}] Stopped`);
  }

  /**
   * 分析窗口
   */
  private async analyzeWindow(workerId: number, window: WindowState): Promise<void> {
    // 1. 获取缓存的截图
    const capturePath = this.cacheManager.getCapturePath(window.hwnd);

    if (!capturePath) {
      console.warn(`[AnalysisWorker ${workerId}] No cached capture for ${window.hwnd}`);
      return;
    }

    // 2. 检查分析缓存
    const existingAnalysis = this.cacheManager.getAnalysis(
      window.hwnd,
      this.config.analysisTTL
    );

    if (existingAnalysis) {
      console.log(`[AnalysisWorker ${workerId}] Cache hit for ${window.hwnd}, skipping analysis`);
      return;
    }

    // 3. 获取上次分析结果（如果有）
    const previousAnalysis = this.cacheManager.getAnalysis(window.hwnd);

    // 4. 读取截图文件
    let base64Image: string;
    try {
      const imageBuffer = readFileSync(capturePath);
      base64Image = imageBuffer.toString('base64');
    } catch (error) {
      console.warn(`[AnalysisWorker ${workerId}] Failed to read capture for ${window.hwnd}:`, error);
      return;
    }

    // 5. LLM 分析
    const analysis = await this.executeWithRetry(
      () => this.analyzeImage(base64Image, window, previousAnalysis?.description),
      this.config.maxRetries
    );

    if (analysis) {
      // 6. 保存分析结果
      await this.cacheManager.saveAnalysis(window.hwnd, analysis, window.title);
      console.log(`[AnalysisWorker ${workerId}] Analyzed: ${window.hwnd}`);
    } else {
      console.warn(`[AnalysisWorker ${workerId}] Analysis failed for ${window.hwnd}`);
    }
  }

  // ========== 私有方法：分析 ==========

  /**
   * 图像分析
   */
  private async analyzeImage(
    base64Image: string,
    window: WindowState,
    previousDescription?: string
  ): Promise<AnalysisResult | null> {
    // 导入 understandImage 函数
    const { understandImage } = await import('./tools.js');

    const description = await understandImage(
      base64Image,
      this.config.client,
      this.config.model,
      {
        processName: window.title.includes(' - ') ? window.title.split(' - ')[0] : window.title,
        windowTitle: window.title,
      },
      previousDescription
    );

    if (!description) {
      return null;
    }

    return {
      description,
      model: this.config.model,
      createdAt: Date.now(),
    };
  }

  // ========== 私有方法：辅助函数 ==========

  /**
   * 重试机制
   */
  private async executeWithRetry<T>(
    task: () => Promise<T>,
    maxRetries: number
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await task();
      } catch (error) {
        if (attempt === maxRetries) {
          console.error(`[AnalysisWorker] Max retries (${maxRetries}) exceeded:`, error);
          return null;
        }
        console.warn(`[AnalysisWorker] Attempt ${attempt + 1} failed, retrying...`);
        await this.sleep(1000);
      }
    }
    return null;
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
