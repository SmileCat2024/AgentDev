/**
 * TTSFeature - 文本朗读功能模块
 *
 * 提供：
 * 1. @StepFinish 钩子：在每个 step 结束时自动朗读模型输出
 *    - 包括工具调用轮和非工具调用轮
 *    - 只要有 assistant 文本回复就会朗读
 *    - 默认自动播放音频（使用 pygame）
 *
 * Python 环境要求：
 * - 需要安装 kokoro、soundfile、pygame 库
 *
 * 安装方式：
 *   uv 方式（推荐）：
 *   uv pip install kokoro soundfile pygame
 *
 *   或使用 pip：
 *   pip install kokoro soundfile pygame
 *
 * Python 调用方式：
 * - 默认使用 'python' 命令（从 PATH 中查找）
 * - 如果使用 uv，可以配置为 'uv run'
 *
 * @example
 * ```typescript
 * import { TTSFeature } from './features/index.js';
 *
 * // 使用默认配置
 * const agent = new Agent({ ... }).use(new TTSFeature());
 *
 * // 自定义声音和语速
 * const agent = new Agent({ ... }).use(new TTSFeature({
 *   model: {
 *     voice: 'zf_xiaoxiao',
 *     speed: 1.3
 *   }
 * }));
 *
 * // 禁用自动播放
 * const agent = new Agent({ ... }).use(new TTSFeature({
 *   output: {
 *     autoPlay: false
 *   }
 * }));
 *
 * // 使用 uv
 * const agent = new Agent({ ... }).use(new TTSFeature({
 *   pythonPath: 'uv',
 *   pythonArgs: ['run']
 * }));
 * ```
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  FeatureStateSnapshot,
  PackageInfo,
} from '../../core/feature.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { StepFinish } from '../../core/hooks-decorator.js';
import type { StepFinishedContext } from '../../core/lifecycle.js';
import type {
  TTSFeatureConfig,
  TTSResult,
  TTSState,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ========== 默认配置 ==========

const DEFAULT_VOICE = 'zf_xiaobei';
const DEFAULT_LANG = 'zh';
const DEFAULT_SPEED = 1.2;

/**
 * 获取项目本地 Python 路径
 * 优先使用 .venv 中的 Python，回退到系统 PATH 中的 python
 */
function getDefaultPythonPath(): string {
  const projectRoot = process.cwd();
  const venvPython =
    process.platform === 'win32'
      ? join(projectRoot, '.venv', 'Scripts', 'python.exe')
      : join(projectRoot, '.venv', 'bin', 'python');

  if (existsSync(venvPython)) {
    console.log(`[TTSFeature] Using project Python: ${venvPython}`);
    return venvPython;
  }

  console.log('[TTSFeature] Using system Python from PATH');
  return 'python';
}

// ========== TTSFeature 实现 ==========

export class TTSFeature implements AgentFeature {
  readonly name = 'tts';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '提供文本朗读能力，支持在非工具调用轮自动朗读模型输出。';

  private config: TTSFeatureConfig & {
    pythonPath: string;
    checkPythonEnv: boolean;
    outputDir: string;
  };

  // 内部状态
  private state: TTSState;
  private _packageInfo: PackageInfo | null = null;

  constructor(config: TTSFeatureConfig = {}) {
    // 初始化状态
    this.state = {
      enabled: true,
      lastUtteranceId: null,
      totalUtterances: 0,
    };

    // 创建输出目录（默认使用项目目录）
    const projectRoot = process.cwd();
    const defaultOutputDir = join(projectRoot, '.agentdev', 'tts');
    const outputDir = config.output?.outputDir || defaultOutputDir;

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    this.config = {
      pythonPath: config.pythonPath ?? getDefaultPythonPath(),
      pythonArgs: config.pythonArgs,
      checkPythonEnv: config.checkPythonEnv ?? true,
      outputDir,
      output: {
        outputDir,
        autoPlay: config.output?.autoPlay ?? true,  // 默认自动播放
      },
      model: {
        voice: config.model?.voice ?? DEFAULT_VOICE,
        lang: config.model?.lang ?? DEFAULT_LANG,
        speed: config.model?.speed ?? DEFAULT_SPEED,
      },
      triggers: {
        autoEnabled: config.triggers?.autoEnabled ?? true,
        minLength: config.triggers?.minLength ?? 10,
        maxLength: config.triggers?.maxLength ?? 1000,
        onlyOnNonToolCalls: config.triggers?.onlyOnNonToolCalls ?? true,
      },
    };
  }

  // ========== AgentFeature 接口实现 ==========

  getTools() {
    return [];
  }

  async getAsyncTools(_ctx: FeatureInitContext) {
    return [];
  }

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   * 此 Feature 没有模板，返回空数组
   */
  getTemplateNames(): string[] {
    return [];
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    console.log(
      `[TTSFeature] Initialized with voice=${this.config.model?.voice}, lang=${this.config.model?.lang}, pythonPath=${this.config.pythonPath}`
    );

    // 检测 Python 环境
    if (this.config.checkPythonEnv) {
      await this.checkPythonEnvironment();
    }
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 清理临时文件（可选）
  }

  captureState(): FeatureStateSnapshot {
    return {
      enabled: this.state.enabled,
      lastUtteranceId: this.state.lastUtteranceId,
      totalUtterances: this.state.totalUtterances,
    };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as TTSState;
    this.state = {
      enabled: state.enabled ?? true,
      lastUtteranceId: state.lastUtteranceId ?? null,
      totalUtterances: state.totalUtterances ?? 0,
    };
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'StepFinish' && methodName === 'speakOnStepFinish') {
      return '在每个 step 结束时自动朗读模型输出的正文部分（包括工具调用轮）。';
    }
    return undefined;
  }

  // ========== 私有方法 ==========

  /**
   * 检测 Python 环境和依赖库
   */
  private async checkPythonEnvironment(): Promise<void> {
    const testScript = `
import sys
try:
    from kokoro import KPipeline
    import soundfile
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
          console.log('[TTSFeature] ✓ Python environment check passed');
        } else {
          console.warn('[TTSFeature] ⚠ Python environment check failed:');
          console.warn(`  Exit code: ${code}`);
          if (stderr) console.warn(`  Error: ${stderr}`);
          console.warn('');
          console.warn('Required Python libraries: kokoro, soundfile');
          console.warn('');
          console.warn('Install with uv:');
          console.warn('  uv pip install kokoro soundfile');
          console.warn('');
          console.warn('Or with pip:');
          console.warn('  pip install kokoro soundfile');
        }
        resolve();
      });

      child.on('error', (error) => {
        console.warn('[TTSFeature] ⚠ Failed to run Python:', error.message);
        console.warn('  Please check your pythonPath configuration.');
        console.warn('  If using uv, try: new TTSFeature({ pythonPath: "uv python" })');
        resolve();
      });
    });
  }

  /**
   * 调用 Python 脚本生成 TTS 音频
   */
  private async generateTTS(text: string): Promise<TTSResult> {
    const scriptPath = join(__dirname, 'python', 'tts.py');
    const utteranceId = randomUUID();
    const outputPath = join(this.config.outputDir, `${utteranceId}.wav`);

    const config = {
      text,
      voice: this.config.model?.voice ?? DEFAULT_VOICE,
      lang: this.config.model?.lang ?? DEFAULT_LANG,
      speed: this.config.model?.speed ?? DEFAULT_SPEED,
      output: outputPath,
    };

    return new Promise((resolve) => {
      const args = this.config.pythonArgs
        ? [...this.config.pythonArgs, scriptPath]
        : [scriptPath];

      const child = spawn(this.config.pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // 将配置通过 stdin 传递给 Python
      child.stdin?.write(JSON.stringify(config));
      child.stdin?.end();

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d) => stdout += d.toString());
      child.stderr?.on('data', (d) => stderr += d.toString());

      child.on('close', (code) => {
        if (code !== 0) {
          resolve({
            success: false,
            error: `Python script failed (exit code ${code}): ${stderr}`,
          });
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.success) {
            this.state.lastUtteranceId = utteranceId;
            this.state.totalUtterances += 1;
            resolve({
              success: true,
              outputPath: result.output_path,
              duration: result.duration,
            });
          } else {
            resolve({
              success: false,
              error: result.error || 'Unknown error',
            });
          }
        } catch (error) {
          resolve({
            success: false,
            error: `Failed to parse Python output: ${error}`,
          });
        }
      });

      child.on('error', (error) => {
        resolve({
          success: false,
          error: `Failed to spawn Python: ${error.message}`,
        });
      });
    });
  }

  /**
   * 提取模型输出的正文部分
   * 过滤掉系统消息、工具调用等，只保留实际的回复内容
   */
  private extractMainResponse(ctx: StepFinishedContext): string | null {
    const messages = ctx.context.getAll();

    // 从后往前找，获取最近的 assistant 消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        // 提取文本内容
        if (typeof msg.content === 'string') {
          return msg.content;
        }

        // 如果是数组格式的内容，提取所有文本
        const content = msg.content as any;
        if (Array.isArray(content)) {
          const textParts = content
            .filter((part: any) => part.type === 'text')
            .map((part: any) => part.text)
            .join('\n');
          return textParts || null;
        }
      }
    }

    return null;
  }

  // ========== 反向钩子（装饰器）==========

  /**
   * 在每个 step 结束时自动朗读模型输出
   * 包括工具调用轮和非工具调用轮
   */
  @StepFinish
  async speakOnStepFinish(ctx: StepFinishedContext): Promise<void> {
    const triggers = this.config.triggers;
    if (!triggers?.autoEnabled || !this.state.enabled) {
      return;
    }

    // 检查是否应该触发（可选）
    // 这里我们总是尝试朗读，因为 @StepFinish 在每个 step 结束时都会调用

    // 提取正文
    const text = this.extractMainResponse(ctx);
    if (!text) {
      // 没有正文内容，不朗读
      return;
    }

    // 检查文本长度
    const minLength = triggers.minLength ?? 10;
    const maxLength = triggers.maxLength ?? 1000;

    if (text.length < minLength) {
      console.log(`[TTSFeature] Text too short (${text.length} < ${minLength}), skipping TTS`);
      return;
    }

    // 截断过长的文本
    let textToSpeak = text;
    if (text.length > maxLength) {
      textToSpeak = text.substring(0, maxLength);
      console.log(`[TTSFeature] Text truncated (${text.length} -> ${maxLength})`);
    }

    // 生成 TTS（Python 侧会自动处理播放）
    console.log(`[TTSFeature] Generating TTS for ${textToSpeak.length} characters...`);
    const result = await this.generateTTS(textToSpeak);

    if (result.success) {
      console.log(
        `[TTSFeature] ✓ TTS generated: ${result.outputPath} (${result.duration?.toFixed(2)}s)`
      );
    } else {
      console.warn(`[TTSFeature] ✗ TTS failed: ${result.error}`);
    }
  }
}

// 重新导出类型
export type { TTSFeatureConfig, TTSResult, TTSState };
