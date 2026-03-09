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
import { createCaptureAndUnderstandTool } from './tools.js';
import { WindowMonitorService } from './monitor.js';
import { CaptureWorkerPool } from './capture-worker.js';
import { AnalysisWorkerPool } from './analysis-worker.js';
import { VisualCacheManager, type CacheMetadataEntry } from './cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ========== 默认配置 ==========

const DEFAULT_BASE_URL = 'http://localhost:7575';
const DEFAULT_MODEL = 'Qwen3.5-4B-Q5_K_M';

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
  };
  private client: OpenAI;

  // 后台监控服务
  private windowMonitorService: WindowMonitorService | null = null;
  private captureWorkerPool: CaptureWorkerPool | null = null;
  private analysisWorkerPool: AnalysisWorkerPool | null = null;
  private cacheManager: VisualCacheManager | null = null;

  // 视觉模式开关（通过 /visual 命令控制）
  private _visualEnabled: boolean = false;

  constructor(config: VisualFeatureConfig = {}) {
    this.config = {
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      model: config.model ?? DEFAULT_MODEL,
      pythonPath: config.pythonPath ?? getDefaultPythonPath(),
      pythonArgs: config.pythonArgs,
      enableWindowInfo: config.enableWindowInfo ?? true,
      checkPythonEnv: config.checkPythonEnv ?? true,
    };

    // 初始化 OpenAI 客户端（连接本地服务）
    this.client = new OpenAI({
      baseURL: `${this.config.baseUrl}/v1`,
      apiKey: 'visual-key', // 本地服务不需要真实 key
    });
  }

  // ========== AgentFeature 接口实现 ==========

  getTools(): Tool[] {
    return [];
  }

  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    return [
      createCaptureAndUnderstandTool(
        this.client,
        this.config.model ?? DEFAULT_MODEL,
        this.config.pythonPath,
        this.config.pythonArgs
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
   * 处理 /visual 命令并注入窗口信息
   *
   * 逻辑：
   * 1. 检测 /visual 命令，切换视觉模式开关
   * 2. 如果是命令，更新输入缓存为纯净内容（去除命令前缀）
   * 3. 如果视觉模式开启（包括刚开启的），立即注入窗口信息
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
      const windows = await this.enumerateWindows();

      // 如果有缓存，添加预热的分析结果
      if (this.cacheManager) {
        const cachedAnalyses = this.formatCachedAnalyses(windows);
        if (cachedAnalyses) {
          ctx.context.add({ role: 'system', content: cachedAnalyses });
        }
      }

      // 基础窗口信息
      const message = this.formatWindowMessage(windows);
      ctx.context.add({ role: 'system', content: message });

      console.log(`[VisualFeature] Injected window info for ${windows.length} windows`);
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
   * 格式化窗口信息为系统消息
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
        lines.push(
          `- **${win.title}** (HWND: \`${win.hwnd}\`)`,
          `  - 类名: ${win.class_name}`,
          `  - 状态: ${win.status}`,
          `  - 位置: (${win.position.x}, ${win.position.y}) 尺寸: ${win.position.width}x${win.position.height}`,
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
   * 格式化缓存的窗口分析结果
   */
  private formatCachedAnalyses(windows: WindowInfo[]): string | null {
    if (!this.cacheManager) return null;

    const entries = this.cacheManager.getAllEntries();
    if (entries.length === 0) return null;

    const lines = [
      '## 窗口视觉理解缓存',
      '',
      `已缓存 ${entries.length} 个窗口的分析结果（由后台监控自动生成）：`,
      '',
    ];

    // 按窗口匹配并添加分析结果
    for (const entry of entries) {
      // 查找匹配的窗口信息
      const win = windows.find(w => w.hwnd === entry.hwnd);
      if (win) {
        lines.push(`## ${win.title} (HWND: \`${entry.hwnd}\`)`);
      } else {
        lines.push(`## ${entry.title} (HWND: \`${entry.hwnd}\`)`);
      }

      lines.push(`**分析结果：**`);
      lines.push(entry.analysis.description);
      lines.push(`*分析时间：${new Date(entry.analysis.createdAt).toLocaleString()}*`);
      lines.push('');
    }

    lines.push('---');
    lines.push('*注：这些分析结果由后台监控自动生成，可能不是最新状态。如需最新分析，请使用 `capture_and_understand_window` 工具。*');

    return lines.join('\n');
  }
}

// 重新导出类型
export type { WindowInfo, CaptureResult, VisualUnderstandingResult, VisualFeatureConfig };
