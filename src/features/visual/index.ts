/**
 * VisualFeature - 视觉理解功能模块
 *
 * 提供：
 * 1. capture_and_understand_window 工具：截图 + 视觉模型理解
 * 2. onCallStart 钩子：自动注入当前窗口状态信息
 *
 * Python 环境要求：
 * - 需要安装 pywin32、psutil、Pillow 库
 *
 * 安装方式：
 *   uv 方式（推荐）：
 *   uv pip install pywin32 psutil Pillow
 *
 *   或使用 pip：
 *   pip install pywin32 psutil Pillow
 *
 * Python 调用方式：
 * - 默认使用 'python' 命令（从 PATH 中查找）
 * - 如果使用 uv，可以配置为 'uv python' 或 'uv run --with pywin32 --with psutil --with Pillow'
 *
 * @example
 * ```typescript
 * import { VisualFeature } from './features/index.js';
 *
 * // 使用默认 python 命令
 * const agent = new Agent({ ... }).use(new VisualFeature());
 *
 * // 使用 uv
 * const agent = new Agent({ ... }).use(new VisualFeature({
 *   pythonPath: 'uv python'
 * }));
 *
 * // 使用 uv run（自动安装依赖）
 * const agent = new Agent({ ... }).use(new VisualFeature({
 *   pythonPath: 'uv'
 *   pythonArgs: ['run', '--with', 'pywin32', '--with', 'psutil', '--with', 'Pillow']
 * }));
 * ```
 */

import { spawn } from 'child_process';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
} from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import { CallStart } from '../../core/hooks-decorator.js';
import type { CallStartContext } from '../../core/lifecycle.js';
import type {
  WindowInfo,
  CaptureResult,
  VisualUnderstandingResult,
  VisualFeatureConfig,
} from './types.js';
import { createCaptureAndUnderstandTool, createCaptureAndUnderstandAdvancedTool } from './tools.js';
import { WindowMonitorService } from './monitor.js';
import { CaptureWorkerPool } from './capture-worker.js';
import { AnalysisWorkerPool } from './analysis-worker.js';
import { VisualCacheManager, type CacheMetadataEntry } from './cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ========== 默认配置 ==========

const DEFAULT_BASE_URL = 'http://localhost:7575';
const DEFAULT_MODEL = 'Qwen3.5-4B-Q5_K_M';

// 主动视觉理解默认配置
const DEFAULT_ADVANCED_BASE_URL = 'http://localhost:7577';
const DEFAULT_ADVANCED_MODEL = 'Qwen3.5-9B-Q4_K_M';

/**
 * 获取项目本地 Python 路径
 * 优先使用 .venv 中的 Python，回退到系统 PATH 中的 python
 */
function getDefaultPythonPath(): string {
  // 检测项目根目录的 .venv
  const projectRoot = process.cwd();
  const venvPython =
    process.platform === 'win32'
      ? join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : join(projectRoot, '.venv', 'bin', 'python');

  if (existsSync(venvPython)) {
    console.log(`[VisualFeature] Using project Python: ${venvPython}`);
    return venvPython;
  }

  console.log('[VisualFeature] Using system Python from PATH');
  return 'python';
}

// ========== VisualFeature 实现 ==========

export class VisualFeature implements AgentFeature {
  readonly name = 'visual';
  readonly dependencies: string[] = [];

  private config: VisualFeatureConfig & {
    pythonPath: string;
    enableWindowInfo: boolean;
    checkPythonEnv: boolean;
    model: string;
    baseUrl: string;
    advancedBaseUrl: string;
    advancedModel: string;
  };
  private client: OpenAI;
  private advancedClient: OpenAI; // 主动视觉理解客户端

  // 后台监控服务
  private windowMonitorService: WindowMonitorService | null = null;
  private captureWorkerPool: CaptureWorkerPool | null = null;
  private analysisWorkerPool: AnalysisWorkerPool | null = null;
  private cacheManager: VisualCacheManager | null = null;

  // 视觉模式开关（通过 /visual 命令控制）
  private _visualEnabled: boolean = false;

  // 增量注入状态跟踪
  private injectionState: {
    isFirstInjection: boolean;
    lastInjectedWindows: Map<string, {
      title: string;
      status: string;
      processPath: string;
      isForeground: boolean;
    }>;
    lastInjectedAnalyses: Map<string, string>; // hwnd -> description hash
    focusHistory: string[]; // 最近焦点切换的窗口 hwnd 列表（最多 3 个）
    lastForegroundHwnd: string | null;
  };

  constructor(config: VisualFeatureConfig = {}) {
    // 初始化增量注入状态
    this.injectionState = {
      isFirstInjection: true,
      lastInjectedWindows: new Map(),
      lastInjectedAnalyses: new Map(),
      focusHistory: [],
      lastForegroundHwnd: null,
    };
    this.config = {
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      model: config.model ?? DEFAULT_MODEL,
      advancedBaseUrl: config.advancedVision?.baseUrl ?? DEFAULT_ADVANCED_BASE_URL,
      advancedModel: config.advancedVision?.model ?? DEFAULT_ADVANCED_MODEL,
      pythonPath: config.pythonPath ?? getDefaultPythonPath(),
      pythonArgs: config.pythonArgs,
      enableWindowInfo: config.enableWindowInfo ?? true,
      checkPythonEnv: config.checkPythonEnv ?? true,
    };

    // 初始化 OpenAI 客户端（自动视觉理解，后台监控使用）
    this.client = new OpenAI({
      baseURL: `${this.config.baseUrl}/v1`,
      apiKey: 'visual-key', // 本地服务不需要真实 key
    });

    // 初始化主动视觉理解客户端（工具调用使用）
    this.advancedClient = new OpenAI({
      baseURL: `${this.config.advancedBaseUrl}/v1`,
      apiKey: 'visual-key',
    });
  }

  // ========== AgentFeature 接口实现 ==========

  getTools(): Tool[] {
    return [];
  }

  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    return [
      // 基础视觉理解工具（4B 模型，快速）
      createCaptureAndUnderstandTool(
        this.client,
        this.config.model ?? DEFAULT_MODEL,
        this.config.pythonPath,
        this.config.pythonArgs,
        this.cacheManager // 传递 cacheManager 以支持缓存回退
      ),
      // 高级视觉理解工具（9B 模型，更准确）
      createCaptureAndUnderstandAdvancedTool(
        this.advancedClient,
        this.config.advancedModel ?? DEFAULT_ADVANCED_MODEL,
        this.config.pythonPath,
        this.config.pythonArgs,
        this.cacheManager // 传递 cacheManager 以支持缓存回退
      ),
    ];
  }

  getTemplatePaths() {
    return {
      capture: join(__dirname, 'templates', 'capture.render.js'),
    };
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    console.log(
      `[VisualFeature] Initialized with baseUrl=${this.config.baseUrl}, model=${this.config.model}, pythonPath=${this.config.pythonPath}`
    );

    // 检测 Python 环境
    if (this.config.checkPythonEnv) {
      await this.checkPythonEnvironment();
    }

    // 初始化后台监控服务
    await this.initializeMonitoring();
  }

  // ========== 私有方法 ==========

  /**
   * 检测 Python 环境和依赖库
   */
  private async checkPythonEnvironment(): Promise<void> {
    const testScript = `
import sys
try:
    import win32gui, win32con, win32ui, win32process
    import psutil
    from PIL import Image
    print("OK")
except ImportError as e:
    print(f"MISSING: {e}")
`;

    return new Promise((resolve) => {
      const args = this.config.pythonArgs
        ? [...this.config.pythonArgs, '-c', testScript]
        : ['-c', testScript];

      const child = spawn(this.config.pythonPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d) => stdout += d.toString());
      child.stderr?.on('data', (d) => stderr += d.toString());

      child.on('close', (code) => {
        if (stdout.includes('OK')) {
          console.log('[VisualFeature] ✓ Python environment check passed');
        } else {
          console.warn('[VisualFeature] ⚠ Python environment check failed:');
          console.warn(`  Exit code: ${code}`);
          if (stderr) console.warn(`  Error: ${stderr}`);
          console.warn('');
          console.warn('Required Python libraries: pywin32, psutil, Pillow');
          console.warn('');
          console.warn('Install with uv:');
          console.warn('  uv pip install pywin32 psutil Pillow');
          console.warn('');
          console.warn('Or with pip:');
          console.warn('  pip install pywin32 psutil Pillow');
        }
        resolve();
      });

      child.on('error', (error) => {
        console.warn('[VisualFeature] ⚠ Failed to run Python:', error.message);
        console.warn('  Please check your pythonPath configuration.');
        console.warn('  If using uv, try: new VisualFeature({ pythonPath: "uv python" })');
        resolve();
      });
    });
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 停止后台监控服务
    await this.stopMonitoring();
  }

  // ========== 后台监控服务初始化 ==========

  /**
   * 初始化后台监控服务
   */
  private async initializeMonitoring(): Promise<void> {
    const monitoringEnabled = this.config.monitoring?.enabled ?? true;

    if (!monitoringEnabled) {
      console.log('[VisualFeature] Background monitoring is disabled');
      return;
    }

    console.log('[VisualFeature] Initializing background monitoring...');

    try {
      // 1. 初始化缓存管理器
      const cacheConfig = {
        cacheDir: this.config.cache?.cacheDir,
        maxSize: this.config.cache?.maxSize,
        maxCount: this.config.cache?.maxCount,
        maxCapturesPerWindow: this.config.cache?.maxCapturesPerWindow ?? 5,
        imageTTL: this.config.cache?.imageTTL,
        analysisTTL: this.config.cache?.analysisTTL,
        cleanupInterval: this.config.cache?.cleanupInterval,
      };

      this.cacheManager = new VisualCacheManager(cacheConfig);
      await this.cacheManager.initialize();

      // 清空缓存，为本次运行做好准备
      await this.cacheManager.clear();

      // 2. 初始化窗口监控服务
      const monitoringConfig = {
        enabled: true,
        pollInterval: this.config.monitoring?.pollInterval ?? 250,
        pythonPath: this.config.pythonPath,
        pythonArgs: this.config.pythonArgs,
        ignoreFilePath: this.config.ignoreFilePath,
        // Worker 数量
        captureWorkerCount: this.config.monitoring?.captureWorkerCount ?? 3,
        analysisWorkerCount: this.config.monitoring?.analysisWorkerCount ?? 1,
        // 截图策略（激进）
        minCaptureInterval: this.config.monitoring?.minCaptureInterval,
        focusChangeCaptureThreshold: this.config.monitoring?.focusChangeCaptureThreshold,
        longFocusCaptureThreshold: this.config.monitoring?.longFocusCaptureThreshold,
        focusDurationCaptureThreshold: this.config.monitoring?.focusDurationCaptureThreshold,
        // 分析策略（保守）
        minAnalysisInterval: this.config.monitoring?.minAnalysisInterval,
        focusChangeAnalysisThreshold: this.config.monitoring?.focusChangeAnalysisThreshold,
        longFocusAnalysisThreshold: this.config.monitoring?.longFocusAnalysisThreshold,
        analysisTTL: this.config.monitoring?.analysisTTL,
      };

      this.windowMonitorService = new WindowMonitorService(monitoringConfig);

      // 3. 初始化 Capture Worker 池
      if (this.captureWorkerPool === null && this.windowMonitorService !== null && this.cacheManager !== null) {
        const captureWorkerConfig = {
          workerCount: monitoringConfig.captureWorkerCount ?? 3,
          pythonPath: this.config.pythonPath,
          pythonArgs: this.config.pythonArgs,
        };

        this.captureWorkerPool = new CaptureWorkerPool(
          captureWorkerConfig,
          this.windowMonitorService,
          this.cacheManager
        );
      }

      // 4. 初始化 Analysis Worker 池
      if (this.analysisWorkerPool === null && this.windowMonitorService !== null && this.cacheManager !== null) {
        const analysisWorkerConfig = {
          workerCount: monitoringConfig.analysisWorkerCount ?? 2,
          client: this.client,
          model: this.config.model,
          maxRetries: this.config.errorHandling?.maxRetries ?? 1,
          analysisTTL: this.config.monitoring?.analysisTTL ?? 300 * 1000, // 5分钟
        };

        this.analysisWorkerPool = new AnalysisWorkerPool(
          analysisWorkerConfig,
          this.windowMonitorService,
          this.cacheManager
        );
      }

      // 5. 启动监控服务和两个 Worker 池
      if (this.windowMonitorService) {
        this.windowMonitorService.startPolling();
      }

      if (this.captureWorkerPool) {
        this.captureWorkerPool.start();
      }

      if (this.analysisWorkerPool) {
        this.analysisWorkerPool.start();
      }

      console.log('[VisualFeature] Background monitoring initialized successfully');
    } catch (error) {
      console.error('[VisualFeature] Failed to initialize background monitoring:', error);
      // 失败不阻塞Feature初始化
    }
  }

  /**
   * 停止后台监控服务
   */
  private async stopMonitoring(): Promise<void> {
    console.log('[VisualFeature] Stopping background monitoring...');

    try {
      // 1. 停止轮询
      if (this.windowMonitorService) {
        this.windowMonitorService.stop();
        this.windowMonitorService = null;
      }

      // 2. 停止 Capture Worker 池
      if (this.captureWorkerPool) {
        await this.captureWorkerPool.stop();
        this.captureWorkerPool = null;
      }

      // 3. 停止 Analysis Worker 池
      if (this.analysisWorkerPool) {
        await this.analysisWorkerPool.stop();
        this.analysisWorkerPool = null;
      }

      // 4. 停止缓存管理器
      if (this.cacheManager) {
        await this.cacheManager.stop();
        this.cacheManager = null;
      }

      console.log('[VisualFeature] Background monitoring stopped');
    } catch (error) {
      console.error('[VisualFeature] Error stopping monitoring:', error);
    }
  }

  // ========== 反向钩子（装饰器）==========

  /**
   * 处理 /visual 命令并注入窗口信息（增量版本）
   *
   * 逻辑：
   * 1. 检测 /visual 命令，切换视觉模式开关
   * 2. 如果是命令，更新输入缓存为纯净内容（去除命令前缀）
   * 3. 如果视觉模式开启（包括刚开启的），立即注入窗口信息
   *
   * 增量注入策略：
   * - 第一次：全量注入（所有窗口 + 所有缓存）
   * - 后续：只注入变化部分（窗口状态变化 + 新的分析结果）
   */
  @CallStart
  async injectWindowInfo(ctx: CallStartContext): Promise<void> {
    if (!this.config.enableWindowInfo) {
      return;
    }

    // 步骤 1：检测斜杠命令格式
    const currentInput = ctx.agent?.getUserInput() ?? ctx.input;
    const match = currentInput.match(/^\/(\w+)\s*(.*)$/);

    if (match) {
      // 是斜杠命令
      const [, command, pureContent] = match;

      // 更新输入缓存为纯净内容（去除命令前缀）
      ctx.agent?.setUserInput(pureContent);

      // 处理 /visual 命令：切换开关
      if (command === 'visual') {
        this._visualEnabled = !this._visualEnabled;
        const status = this._visualEnabled ? '开启' : '关闭';

        // 重置增量注入状态
        if (this._visualEnabled) {
          this.injectionState.isFirstInjection = true;
          this.injectionState.lastInjectedWindows.clear();
          this.injectionState.lastInjectedAnalyses.clear();
          this.injectionState.focusHistory = [];
          this.injectionState.lastForegroundHwnd = null;
        }

        ctx.context.add({
          role: 'system',
          content: `[视觉模式已${status}]`
        });
        console.log(`[VisualFeature] 视觉模式已${status}`);
      }
    }

    // 步骤 2：如果视觉模式开启（包括刚开启的），注入窗口信息
    if (!this._visualEnabled) {
      return;
    }

    try {
      // 获取当前焦点窗口（用于焦点历史追踪）
      const foregroundHwnd = await this.getForegroundWindow();
      if (foregroundHwnd && foregroundHwnd !== this.injectionState.lastForegroundHwnd) {
        // 焦点切换了，记录到历史
        this.injectionState.focusHistory.push(foregroundHwnd);
        // 只保留最近 3 个
        if (this.injectionState.focusHistory.length > 3) {
          this.injectionState.focusHistory.shift();
        }
        this.injectionState.lastForegroundHwnd = foregroundHwnd;
      }

      const windows = await this.enumerateWindows();

      // 合并注入：窗口状态变化 + 缓存分析变化
      const message = this.formatIncrementalMessage(windows, foregroundHwnd);

      if (message) {
        ctx.context.add({ role: 'system', content: message });

        const injectionType = this.injectionState.isFirstInjection ? '全量' : '增量';
        console.log(`[VisualFeature] ${injectionType}注入窗口信息 (${windows.length} 个窗口)`);
      }

      // 更新状态（标记非首次注入）
      this.injectionState.isFirstInjection = false;
    } catch (error) {
      console.warn(`[VisualFeature] Failed to inject window info:`, error);
      // 失败时不阻塞，只记录警告
    }
  }

  // ========== 私有方法 ==========

  /**
   * 调用 Python 脚本枚举所有窗口
   */
  private async enumerateWindows(): Promise<WindowInfo[]> {
    const scriptPath = join(__dirname, 'python', 'list_windows.py');

    return new Promise((resolve, reject) => {
      // 支持 pythonArgs 配置（如 uv run）
      // 如果配置了 ignoreFilePath，则作为第二个参数传递给 Python 脚本
      const args = this.config.pythonArgs
        ? [...this.config.pythonArgs, scriptPath]
        : [scriptPath];

      // 如果配置了自定义 ignore 文件路径，添加为参数
      if (this.config.ignoreFilePath) {
        args.push(this.config.ignoreFilePath);
      }

      // 继承父进程的环境变量（包括 PATH），这样能找到 uv 管理的 Python
      const child = spawn(this.config.pythonPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }, // 继承环境变量
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
   * 获取当前焦点窗口句柄
   */
  private async getForegroundWindow(): Promise<string | null> {
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
   * 格式化窗口信息为系统消息（全量版本，用于首次注入）
   */
  private formatWindowMessage(windows: WindowInfo[]): string {
    const lines = [
      '## 当前系统窗口状态',
      '',
      `检测到 ${windows.length} 个可见窗口：`,
      '',
    ];

    // 按进程分组
    const byProcess = new Map<string, WindowInfo[]>();
    for (const win of windows) {
      const key = win.process_name ?? 'Unknown';
      if (!byProcess.has(key)) {
        byProcess.set(key, []);
      }
      byProcess.get(key)!.push(win);
    }

    // 生成详细信息
    for (const [processName, wins] of byProcess.entries()) {
      lines.push(`### ${processName}`);
      for (const win of wins) {
        // 不显示窗口尺寸位置，显示进程 exe 路径
        lines.push(
          `- **${win.title}** (HWND: \`${win.hwnd}\`)`,
          `  - 类名: ${win.class_name}`,
          `  - 状态: ${win.status}`,
          `  - 进程路径: \`${win.process_path}\``,
          `  - PID: ${win.pid}${win.is_always_on_top ? ' | 置顶' : ''}`
        );
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('*提示：你可以使用 `capture_and_understand_window` 工具来获取特定窗口的详细截图和内容分析。*');

    return lines.join('\n');
  }

  /**
   * 格式化缓存的窗口分析结果（全量版本，用于首次注入）
   */
  private formatCachedAnalyses(windows: WindowInfo[]): string | null {
    if (!this.cacheManager) return null;

    const entries = this.cacheManager.getAllEntries();
    if (entries.length === 0) return null;

    const lines: string[] = [];

    // 按窗口匹配并添加分析结果
    for (const entry of entries) {
      // 查找匹配的窗口信息
      const win = windows.find(w => w.hwnd === entry.hwnd);
      if (win) {
        lines.push(`### ${win.title} (HWND: \`${entry.hwnd}\`)`);
      } else {
        lines.push(`### ${entry.title} (HWND: \`${entry.hwnd}\`)`);
      }

      lines.push(`**分析结果：** ${entry.analysis.description}`);
      lines.push(`*分析时间：${new Date(entry.analysis.createdAt).toLocaleString()}*`);
      lines.push('');
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  // ========== 增量注入相关方法 ==========

  /**
   * 计算简单哈希（用于检测内容变化）
   */
  private hashDescription(description: string): string {
    // 简单哈希：取前 50 个字符 + 长度，避免大字符串比较
    const prefix = description.slice(0, 50);
    return `${prefix}...[${description.length}]`;
  }

  /**
   * 计算窗口状态变化
   */
  private computeWindowChanges(windows: WindowInfo[], foregroundHwnd: string | null): {
    newWindows: WindowInfo[];
    closedWindows: string[];
    statusChanged: Array<{ hwnd: string; title: string; oldStatus: string; newStatus: string }>;
    titleChanged: Array<{ hwnd: string; oldTitle: string; newTitle: string }>;
    recentFocus: string[]; // 最近焦点切换的窗口句柄列表
  } {
    const currentHwnds = new Set(windows.map(w => w.hwnd));
    const previousHwnds = new Set(this.injectionState.lastInjectedWindows.keys());

    // 新窗口（打开或最大化）
    const newWindows: WindowInfo[] = [];
    for (const win of windows) {
      const prev = this.injectionState.lastInjectedWindows.get(win.hwnd);
      if (!prev) {
        // 新窗口
        newWindows.push(win);
      } else {
        // 检查状态变化：从最小化变为正常/最大化 = 打开
        if (prev.status === 'Minimized' && win.status !== 'Minimized') {
          newWindows.push(win);
        }
      }
    }

    // 关闭的窗口（从上次列表中消失，或变为最小化）
    const closedWindows: string[] = [];
    for (const [hwnd, prev] of this.injectionState.lastInjectedWindows) {
      const current = windows.find(w => w.hwnd === hwnd);
      if (!current) {
        // 窗口不存在了 = 关闭
        closedWindows.push(hwnd);
      } else if (current.status === 'Minimized' && prev.status !== 'Minimized') {
        // 从正常变为最小化 = 缩小
        closedWindows.push(hwnd);
      }
    }

    // 状态变化（不包括新打开/关闭的）
    const statusChanged: Array<{ hwnd: string; title: string; oldStatus: string; newStatus: string }> = [];
    for (const win of windows) {
      const prev = this.injectionState.lastInjectedWindows.get(win.hwnd);
      if (prev && prev.status !== win.status) {
        // 排除刚从最小化恢复的情况（已算在 newWindows 中）
        if (!(prev.status === 'Minimized' && win.status !== 'Minimized')) {
          statusChanged.push({
            hwnd: win.hwnd,
            title: win.title,
            oldStatus: prev.status,
            newStatus: win.status,
          });
        }
      }
    }

    // 标题变化
    const titleChanged: Array<{ hwnd: string; oldTitle: string; newTitle: string }> = [];
    for (const win of windows) {
      const prev = this.injectionState.lastInjectedWindows.get(win.hwnd);
      if (prev && prev.title !== win.title) {
        titleChanged.push({
          hwnd: win.hwnd,
          oldTitle: prev.title,
          newTitle: win.title,
        });
      }
    }

    return {
      newWindows,
      closedWindows,
      statusChanged,
      titleChanged,
      recentFocus: this.injectionState.focusHistory.slice(-3), // 最近 3 个焦点窗口
    };
  }

  /**
   * 计算缓存分析结果变化
   */
  private computeAnalysisChanges(windows: WindowInfo[]): Array<{
    hwnd: string;
    title: string;
    description: string;
    isUpdate: boolean;
  }> {
    if (!this.cacheManager) return [];

    const entries = this.cacheManager.getAllEntries();
    const changes: Array<{ hwnd: string; title: string; description: string; isUpdate: boolean }> = [];

    for (const entry of entries) {
      const win = windows.find(w => w.hwnd === entry.hwnd);
      const title = win?.title ?? entry.title;
      const currentHash = this.hashDescription(entry.analysis.description);
      const previousHash = this.injectionState.lastInjectedAnalyses.get(entry.hwnd);

      if (!previousHash) {
        // 新的分析结果
        changes.push({
          hwnd: entry.hwnd,
          title,
          description: entry.analysis.description,
          isUpdate: false,
        });
      } else if (previousHash !== currentHash) {
        // 分析结果更新了
        changes.push({
          hwnd: entry.hwnd,
          title,
          description: entry.analysis.description,
          isUpdate: true,
        });
      }
    }

    return changes;
  }

  /**
   * 格式化窗口变化
   */
  private formatWindowChanges(changes: ReturnType<typeof this.computeWindowChanges>): string | null {
    const lines: string[] = [];

    // 新打开/最大化的窗口
    if (changes.newWindows.length > 0) {
      lines.push('## 新打开/最大化的窗口');
      for (const win of changes.newWindows) {
        lines.push(`- **${win.title}** (HWND: \`${win.hwnd}\`)`);
        lines.push(`  - 进程: ${win.process_name}`);
        lines.push(`  - 状态: ${win.status}`);
        lines.push(`  - 进程路径: \`${win.process_path}\``);
        lines.push('');
      }
    }

    // 关闭/缩小的窗口
    if (changes.closedWindows.length > 0) {
      lines.push('## 关闭/缩小的窗口');
      for (const hwnd of changes.closedWindows) {
        const prev = this.injectionState.lastInjectedWindows.get(hwnd);
        lines.push(`- **${prev?.title ?? 'Unknown'}** (HWND: \`${hwnd}\`)`);
        lines.push('');
      }
    }

    // 状态变化
    if (changes.statusChanged.length > 0) {
      lines.push('## 窗口状态变化');
      for (const change of changes.statusChanged) {
        lines.push(`- **${change.title}** (HWND: \`${change.hwnd}\`)`);
        lines.push(`  - ${change.oldStatus} → ${change.newStatus}`);
        lines.push('');
      }
    }

    // 标题变化
    if (changes.titleChanged.length > 0) {
      lines.push('## 窗口标题变化');
      for (const change of changes.titleChanged) {
        lines.push(`- (HWND: \`${change.hwnd}\`)`);
        lines.push(`  - "${change.oldTitle}" → "${change.newTitle}"`);
        lines.push('');
      }
    }

    // 最近焦点切换的窗口
    if (changes.recentFocus.length > 0) {
      lines.push('## 最近焦点切换');
      const titles = changes.recentFocus.map(hwnd => {
        const win = changes.newWindows.find(w => w.hwnd === hwnd);
        if (win) return win.title;
        const prev = this.injectionState.lastInjectedWindows.get(hwnd);
        return prev?.title ?? hwnd;
      });
      lines.push(titles.map((t, i) => `${i + 1}. ${t}`).join('\n'));
      lines.push('');
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * 格式化分析变化
   */
  private formatAnalysisChanges(changes: ReturnType<typeof this.computeAnalysisChanges>): string | null {
    if (changes.length === 0) return null;

    const lines = ['## 窗口内容更新', ''];

    for (const change of changes) {
      lines.push(`### ${change.title} (HWND: \`${change.hwnd}\`)`);
      lines.push(change.isUpdate ? '**更新内容：**' : '**新识别内容：**');
      lines.push(change.description);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 格式化增量消息（合并窗口状态变化 + 缓存分析变化 + 首次全量）
   */
  private formatIncrementalMessage(windows: WindowInfo[], foregroundHwnd: string | null): string | null {
    const lines: string[] = [];

    if (this.injectionState.isFirstInjection) {
      // ========== 首次注入：全量 ==========

      // 1. 窗口状态（全量）
      lines.push(this.formatWindowMessage(windows));

      // 2. 缓存分析（全量）
      const cachedAnalyses = this.formatCachedAnalyses(windows);
      if (cachedAnalyses) {
        lines.push('');
        lines.push('## 窗口视觉理解缓存');
        lines.push('');
        lines.push(cachedAnalyses);
      }

      // 更新状态记录
      for (const win of windows) {
        this.injectionState.lastInjectedWindows.set(win.hwnd, {
          title: win.title,
          status: win.status,
          processPath: win.process_path,
          isForeground: win.hwnd === foregroundHwnd,
        });
      }

      // 记录已注入的分析
      if (this.cacheManager) {
        const entries = this.cacheManager.getAllEntries();
        for (const entry of entries) {
          this.injectionState.lastInjectedAnalyses.set(
            entry.hwnd,
            this.hashDescription(entry.analysis.description)
          );
        }
      }
    } else {
      // ========== 后续注入：增量 ==========

      // 1. 计算窗口状态变化
      const windowChanges = this.computeWindowChanges(windows, foregroundHwnd);
      const windowChangesText = this.formatWindowChanges(windowChanges);

      // 2. 计算缓存分析变化
      const analysisChanges = this.computeAnalysisChanges(windows);
      const analysisChangesText = this.formatAnalysisChanges(analysisChanges);

      // 3. 合并输出
      if (windowChangesText || analysisChangesText) {
        if (windowChangesText) {
          lines.push(windowChangesText);
        }

        if (analysisChangesText) {
          if (lines.length > 0) lines.push('');
          lines.push(analysisChangesText);
        }

        lines.push('---');
        lines.push('*提示：你可以使用 `capture_and_understand_window` 工具来获取特定窗口的详细截图和内容分析。*');
      }

      // 更新状态记录
      for (const win of windows) {
        this.injectionState.lastInjectedWindows.set(win.hwnd, {
          title: win.title,
          status: win.status,
          processPath: win.process_path,
          isForeground: win.hwnd === foregroundHwnd,
        });
      }

      // 记录已注入的分析
      if (this.cacheManager) {
        const entries = this.cacheManager.getAllEntries();
        for (const entry of entries) {
          this.injectionState.lastInjectedAnalyses.set(
            entry.hwnd,
            this.hashDescription(entry.analysis.description)
          );
        }
      }
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }
}

// 重新导出类型
export type { WindowInfo, CaptureResult, VisualUnderstandingResult, VisualFeatureConfig };
