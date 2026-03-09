/**
 * WindowMonitorService - 窗口监控服务
 *
 * 职责：
 * 1. 高频轮询（0.25秒）更新窗口焦点状态
 * 2. 维护窗口状态表（实时）
 * 3. 提供动态优先级查询接口
 *
 * 核心原则：
 * - 轮询只做状态跟踪（高频、轻量）
 * - 不截图、不压入任务队列、不处理任何窗口
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { WindowInfo } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ========== 类型定义 ==========

/**
 * 窗口状态（实时）
 */
export interface WindowState {
  // 基础信息
  hwnd: string;
  title: string;
  isVisible: boolean;

  // 焦点状态（实时）
  isForeground: boolean;
  focusStartTime: number;        // 成为焦点的时间戳
  lastFocusTime: number;          // 上次失去焦点的时间戳

  // 最大化状态（实时）
  isMaximized: boolean;          // 是否最大化
  lastMaximizedAt: number;        // 上次成为最大的时间戳

  // 截图状态
  lastCapturedAt: number;         // 上次截图的时间戳
  isCapturing: boolean;           // 是否正在截图中

  // 分析状态
  lastAnalyzedAt: number;         // 上次分析的时间戳
  isAnalyzing: boolean;           // 是否正在分析中

  // 优先级指标
  priorityScore: number;          // 动态计算的优先级分数
}

/**
 * 监控服务配置
 */
export interface MonitoringConfig {
  /** 是否启用后台监控 */
  enabled: boolean;
  /** 轮询间隔（毫秒），默认 250 */
  pollInterval: number;
  /** Python可执行文件路径 */
  pythonPath: string;
  /** Python参数 */
  pythonArgs?: string[];
  /** 忽略文件路径 */
  ignoreFilePath?: string;

  // ========== 截图 Worker 配置 ==========
  /** 截图 Worker 数量，默认 3 */
  captureWorkerCount?: number;
  /** 分析 Worker 数量，默认 1 */
  analysisWorkerCount?: number;

  // ========== 截图策略（激进）==========
  /** 同一窗口两次截图的最小间隔（毫秒），默认 5 秒 */
  minCaptureInterval?: number;
  /** 失去焦点多久后重新获得焦点需要重新截图（毫秒），默认 15 秒 */
  focusChangeCaptureThreshold?: number;
  /** 焦点持续多久后需要重新截图（毫秒），默认 30 秒 */
  longFocusCaptureThreshold?: number;
  /** 焦点状态持续多久后需要截图（毫秒），默认 10 秒 */
  focusDurationCaptureThreshold?: number;

  // ========== 分析策略（保守）==========
  /** 同一窗口两次分析的最小间隔（毫秒），默认 60 秒 */
  minAnalysisInterval?: number;
  /** 失去焦点多久后重新获得焦点需要重新分析（毫秒），默认 30 秒 */
  focusChangeAnalysisThreshold?: number;
  /** 焦点持续多久后需要重新分析（毫秒），默认 60 秒 */
  longFocusAnalysisThreshold?: number;
  /** 缓存过期时间（毫秒），默认 300 秒（5分钟） */
  analysisTTL?: number;
}

// ========== 默认配置 ==========

const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  enabled: true,
  pollInterval: 250,
  pythonPath: 'python',
  // Worker 数量
  captureWorkerCount: 3,
  analysisWorkerCount: 1,  // 单线程分析，避免连接压力
  // 截图策略（激进）
  minCaptureInterval: 5 * 1000,              // 5秒
  focusChangeCaptureThreshold: 15 * 1000,    // 15秒
  longFocusCaptureThreshold: 30 * 1000,      // 30秒
  focusDurationCaptureThreshold: 10 * 1000,  // 焦点持续10秒后截图
  // 分析策略（保守）
  minAnalysisInterval: 60 * 1000,            // 60秒
  focusChangeAnalysisThreshold: 30 * 1000,   // 30秒
  longFocusAnalysisThreshold: 60 * 1000,     // 60秒
  analysisTTL: 300 * 1000,                   // 300秒（5分钟）
};

// ========== WindowMonitorService 类 ==========

export class WindowMonitorService {
  private config: MonitoringConfig;
  private windowStates: Map<string, WindowState> = new Map();
  private currentForegroundHwnd: string | null = null;
  private pollIntervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config: Partial<MonitoringConfig> = {}) {
    this.config = { ...DEFAULT_MONITORING_CONFIG, ...config };
  }

  // ========== 生命周期管理 ==========

  /**
   * 启动轮询
   */
  startPolling(): void {
    if (this.isRunning) {
      console.warn('[WindowMonitorService] Already running');
      return;
    }

    console.log(`[WindowMonitorService] Starting polling (interval: ${this.config.pollInterval}ms)`);
    this.isRunning = true;

    // 初始扫描
    this.poll().catch(err => {
      console.error('[WindowMonitorService] Initial poll failed:', err);
    });

    // 启动轮询循环
    this.pollIntervalId = setInterval(() => {
      this.poll().catch(err => {
        console.error('[WindowMonitorService] Poll failed:', err);
      });
    }, this.config.pollInterval);
  }

  /**
   * 停止轮询
   */
  stop(): void {
    console.log('[WindowMonitorService] Stopping polling');

    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }

    this.isRunning = false;
  }

  // ========== 核心功能 ==========

  /**
   * 获取最高优先级且需要截图的窗口（激进策略）
   * @returns 最高优先级窗口状态，如果没有需要截图的窗口返回null
   */
  getHighestPriorityWindowForCapture(): WindowState | null {
    const now = Date.now();
    const minInterval = this.config.minCaptureInterval ?? 5 * 1000;
    const focusChangeThreshold = this.config.focusChangeCaptureThreshold ?? 15 * 1000;
    const focusDurationThreshold = this.config.focusDurationCaptureThreshold ?? 10 * 1000;

    // 1. 筛选需要截图的窗口
    const candidates = Array.from(this.windowStates.values())
      .filter(state => {
        // 前置条件：非截图中 + 可见
        if (state.isCapturing || !state.isVisible) {
          return false;
        }

        // 判断是否需要截图
        return this.shouldCaptureWindow(state, now, minInterval, focusChangeThreshold, focusDurationThreshold);
      });

    if (candidates.length === 0) {
      return null;
    }

    // 2. 按优先级排序
    candidates.sort((a, b) => {
      // 规则1: 当前焦点窗口优先
      if (a.isForeground && !b.isForeground) return -1;
      if (!a.isForeground && b.isForeground) return 1;

      // 规则2: 都是非焦点，按最近焦点时间排序
      if (!a.isForeground && !b.isForeground) {
        return b.lastFocusTime - a.lastFocusTime;
      }

      // 规则3: 都是焦点或都不是焦点，按上次截图时间排序
      return a.lastCapturedAt - b.lastCapturedAt;
    });

    // 3. 返回最高优先级窗口
    return candidates[0];
  }

  /**
   * 获取最高优先级且需要分析的窗口（保守策略）
   * @returns 最高优先级窗口状态，如果没有需要分析的窗口返回null
   */
  getHighestPriorityWindowForAnalysis(): WindowState | null {
    const now = Date.now();
    const minInterval = this.config.minAnalysisInterval ?? 60 * 1000;
    const focusChangeThreshold = this.config.focusChangeAnalysisThreshold ?? 30 * 1000;
    const longFocusThreshold = this.config.longFocusAnalysisThreshold ?? 60 * 1000;
    const analysisTTL = this.config.analysisTTL ?? 300 * 1000;

    // 1. 筛选需要分析的窗口
    const candidates = Array.from(this.windowStates.values())
      .filter(state => {
        // 前置条件：非分析中 + 可见 + 有截图
        if (state.isAnalyzing || !state.isVisible) {
          return false;
        }

        // 没有截图，无法分析
        if (state.lastCapturedAt === 0) {
          return false;
        }

        // 判断是否需要分析
        return this.shouldAnalyzeWindow(state, now, minInterval, focusChangeThreshold, longFocusThreshold, analysisTTL);
      });

    if (candidates.length === 0) {
      return null;
    }

    // 2. 按优先级排序
    candidates.sort((a, b) => {
      // 规则1: 当前焦点窗口优先
      if (a.isForeground && !b.isForeground) return -1;
      if (!a.isForeground && b.isForeground) return 1;

      // 规则2: 都是非焦点，按最近焦点时间排序
      if (!a.isForeground && !b.isForeground) {
        return b.lastFocusTime - a.lastFocusTime;
      }

      // 规则3: 都是焦点或都不是焦点，按上次分析时间排序
      return a.lastAnalyzedAt - b.lastAnalyzedAt;
    });

    // 3. 返回最高优先级窗口
    return candidates[0];
  }

  /**
   * 判断窗口是否需要截图（激进策略）
   */
  private shouldCaptureWindow(
    state: WindowState,
    now: number,
    minInterval: number,
    focusChangeThreshold: number,
    focusDurationThreshold: number
  ): boolean {
    const timeSinceCapture = now - state.lastCapturedAt;

    // 条件 1: 从未截图过
    if (state.lastCapturedAt === 0) {
      return true;
    }

    // 条件 2: 刚截图过不久，跳过（最小间隔）
    if (timeSinceCapture < minInterval) {
      return false;
    }

    // 条件 3: 刚最大化，需要截图
    if (state.isMaximized && (now - state.lastMaximizedAt) < 1000) {
      // 刚进入最大化状态（1秒内）
      return true;
    }

    // 条件 4: 焦点触发场景（激进）
    if (state.isForeground) {
      const timeSinceLostFocus = now - state.lastFocusTime;

      // 失去焦点超过阈值，现在又成为焦点 → 需要重新截图
      if (timeSinceLostFocus > focusChangeThreshold) {
        return true;
      }

      // 一直是焦点，且持续一定时间 → 需要重新截图
      const focusDuration = now - state.focusStartTime;
      // 检查是否达到焦点持续时间阈值（每10秒触发一次）
      const durationSinceLastCapture = focusDuration - (state.lastCapturedAt - state.focusStartTime);
      if (durationSinceLastCapture >= focusDurationThreshold) {
        return true;
      }
    }

    // 默认不需要截图
    return false;
  }

  /**
   * 判断窗口是否需要分析（保守策略）
   */
  private shouldAnalyzeWindow(
    state: WindowState,
    now: number,
    minInterval: number,
    focusChangeThreshold: number,
    longFocusThreshold: number,
    analysisTTL: number
  ): boolean {
    const timeSinceAnalysis = now - state.lastAnalyzedAt;

    // 条件 1: 从未分析过
    if (state.lastAnalyzedAt === 0) {
      return true;
    }

    // 条件 2: 刚分析过不久，跳过（最小间隔）
    if (timeSinceAnalysis < minInterval) {
      return false;
    }

    // 条件 3: 焦点重置场景
    if (state.isForeground) {
      const timeSinceLostFocus = now - state.lastFocusTime;

      // 失去焦点超过阈值，现在又成为焦点 → 需要重新分析
      if (timeSinceLostFocus > focusChangeThreshold) {
        return true;
      }

      // 一直是焦点，但持续很久了 → 需要重新分析
      const focusDuration = now - state.focusStartTime;
      if (focusDuration > longFocusThreshold) {
        return true;
      }
    } else {
      // 非焦点窗口，只有分析结果过期时才处理
      if (timeSinceAnalysis > analysisTTL) {
        return true;
      }
    }

    // 默认不需要分析
    return false;
  }

  /**
   * 获取窗口状态
   * @param hwnd 窗口句柄
   * @returns 窗口状态，如果不存在返回undefined
   */
  getWindowState(hwnd: string): WindowState | undefined {
    return this.windowStates.get(hwnd);
  }

  /**
   * 获取所有窗口状态
   * @returns 所有窗口状态数组
   */
  getAllWindowStates(): WindowState[] {
    return Array.from(this.windowStates.values());
  }

  /**
   * 标记窗口为截图中
   * @param hwnd 窗口句柄
   */
  markCapturing(hwnd: string): void {
    const state = this.windowStates.get(hwnd);
    if (state) {
      state.isCapturing = true;
    }
  }

  /**
   * 标记窗口截图完成
   * @param hwnd 窗口句柄
   */
  markCaptureDone(hwnd: string): void {
    const state = this.windowStates.get(hwnd);
    if (state) {
      state.isCapturing = false;
      state.lastCapturedAt = Date.now();
    }
  }

  /**
   * 标记窗口为分析中
   * @param hwnd 窗口句柄
   */
  markAnalyzing(hwnd: string): void {
    const state = this.windowStates.get(hwnd);
    if (state) {
      state.isAnalyzing = true;
    }
  }

  /**
   * 标记窗口分析完成
   * @param hwnd 窗口句柄
   */
  markAnalysisDone(hwnd: string): void {
    const state = this.windowStates.get(hwnd);
    if (state) {
      state.isAnalyzing = false;
      state.lastAnalyzedAt = Date.now();
    }
  }

  /**
   * 更新窗口标题
   * @param hwnd 窗口句柄
   * @param title 新标题
   */
  updateWindowTitle(hwnd: string, title: string): void {
    const state = this.windowStates.get(hwnd);
    if (state) {
      state.title = title;
    }
  }

  // ========== 私有方法 ==========

  /**
   * 轮询更新窗口状态
   */
  private async poll(): Promise<void> {
    try {
      // 1. 获取当前焦点窗口
      const foregroundHwnd = await this.getForegroundWindow();

      // 2. 扫描所有可见窗口
      const windows = await this.enumerateWindows();

      // 3. 更新窗口状态
      await this.updateWindowStates(foregroundHwnd, windows);
    } catch (error) {
      console.error('[WindowMonitorService] Poll error:', error);
    }
  }

  /**
   * 获取当前焦点窗口句柄
   */
  private async getForegroundWindow(): Promise<string | null> {
    // 使用Python脚本获取焦点窗口
    const scriptPath = join(__dirname, 'python', 'get_foreground_window.py');

    return new Promise((resolve) => {
      const args = this.config.pythonArgs
        ? [...this.config.pythonArgs, scriptPath]
        : [scriptPath];

      const child = spawn(this.config.pythonPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          resolve(null);
        }
      });

      child.on('error', () => {
        resolve(null);
      });
    });
  }

  /**
   * 枚举所有可见窗口
   */
  private async enumerateWindows(): Promise<WindowInfo[]> {
    const scriptPath = join(__dirname, 'python', 'list_windows.py');

    return new Promise((resolve, reject) => {
      const args = this.config.pythonArgs
        ? [...this.config.pythonArgs, scriptPath]
        : [scriptPath];

      // 添加ignore文件路径
      if (this.config.ignoreFilePath) {
        args.push(this.config.ignoreFilePath);
      }

      const child = spawn(this.config.pythonPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python script failed (exit code ${code}): ${stderr}`));
          return;
        }

        try {
          const windows: WindowInfo[] = JSON.parse(stdout.trim());
          resolve(windows);
        } catch (error) {
          reject(new Error(`Failed to parse Python output: ${error}`));
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to spawn Python: ${error.message}`));
      });
    });
  }

  /**
   * 更新窗口状态
   */
  private async updateWindowStates(
    foregroundHwnd: string | null,
    windows: WindowInfo[]
  ): Promise<void> {
    const now = Date.now();
    const currentHwnds = new Set<string>();

    // 更新或添加窗口
    for (const win of windows) {
      currentHwnds.add(win.hwnd);

      let state = this.windowStates.get(win.hwnd);

      if (!state) {
        // 新窗口
        state = {
          hwnd: win.hwnd,
          title: win.title,
          isVisible: win.status !== 'Minimized',
          isForeground: win.hwnd === foregroundHwnd,
          focusStartTime: win.hwnd === foregroundHwnd ? now : 0,
          lastFocusTime: win.hwnd === foregroundHwnd ? now : 0,
          isMaximized: win.status === 'Maximized',
          lastMaximizedAt: win.status === 'Maximized' ? now : 0,
          lastCapturedAt: 0,
          isCapturing: false,
          lastAnalyzedAt: 0,
          isAnalyzing: false,
          priorityScore: 0,
        };

        this.windowStates.set(win.hwnd, state);
      } else {
        // 更新现有窗口
        const wasForeground = state.isForeground;
        const wasMaximized = state.isMaximized;

        state.isForeground = win.hwnd === foregroundHwnd;
        state.isVisible = win.status !== 'Minimized';
        state.isMaximized = win.status === 'Maximized';

        if (state.isForeground) {
          // 成为焦点
          state.focusStartTime = now;
          state.lastFocusTime = now;
        } else if (wasForeground && !state.isForeground) {
          // 刚失去焦点
          state.lastFocusTime = now;
        }

        // 检测最大化状态变化
        if (state.isMaximized && !wasMaximized) {
          // 刚进入最大化状态
          state.lastMaximizedAt = now;
        }

        // 更新标题（如果变化）
        if (state.title !== win.title) {
          state.title = win.title;
        }
      }
    }

    // 移除已关闭的窗口
    for (const hwnd of this.windowStates.keys()) {
      if (!currentHwnds.has(hwnd)) {
        this.windowStates.delete(hwnd);
        // console.log(`[WindowMonitorService] Removed closed window: ${hwnd}`);
      }
    }

    // 更新当前焦点窗口
    if (foregroundHwnd !== this.currentForegroundHwnd) {
      if (foregroundHwnd) {
        const state = this.windowStates.get(foregroundHwnd);
        if (state) {
          console.log(`[WindowMonitorService] Focus changed: ${state.title} (${foregroundHwnd})`);
        }
      }
      this.currentForegroundHwnd = foregroundHwnd;
    }
  }
}
