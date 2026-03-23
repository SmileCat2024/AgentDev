/**
 * TTSFeature - 文本朗读功能模块
 *
 * 使用小米 Mimo TTS API 进行文本转语音：
 * - 在每个 step 结束时自动朗读模型输出
 * - 支持工具调用轮和非工具调用轮
 * - 生成后立即播放，不保存音频文件
 *
 * @example
 * ```typescript
 * import { TTSFeature } from '@agentdev/tts-feature';
 *
 * // 使用默认配置
 * const agent = new Agent({ ... }).use(new TTSFeature());
 *
 * // 自定义 API 配置
 * const agent = new Agent({ ... }).use(new TTSFeature({
 *   api: {
 *     apiKey: 'your-api-key',
 *     baseURL: 'https://api.xiaomimimo.com/v1',
 *     voice: 'default_zh'
 *   },
 *   style: {
 *     systemPrompt: '你是一个活泼的香港女生',
 *     styleTags: '开心 粤语 撒娇'
 *   }
 * }));
 *
 * // 禁用自动播放
 * const agent = new Agent({ ... }).use(new TTSFeature({
 *   output: { autoPlay: false }
 * }));
 * ```
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import soundPlay from 'sound-play';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  FeatureStateSnapshot,
  PackageInfo,
} from 'agentdev';
import { getPackageInfoFromSource } from 'agentdev';
import { StepFinish } from 'agentdev';
import type { StepFinishedContext } from 'agentdev';
import type {
  TTSFeatureConfig,
  TTSResult,
  TTSState,
} from './types.js';

// ========== 默认配置 ==========

const DEFAULT_API_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MODEL = 'mimo-v2-tts';
const DEFAULT_VOICE = 'default_zh';
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_SYSTEM_PROMPT = '你是一个活泼的香港女生，正在和朋友聊天，用粤语口吻';
const DEFAULT_STYLE_TAGS = '开心 粤语 撒娇';

// ========== TTSFeature 实现 ==========

export class TTSFeature implements AgentFeature {
  readonly name = 'tts';
  readonly dependencies: string[] = [];
  readonly source = import.meta.url.replace(/^file:\/\/\//, '').replace(/\\/g, '/');
  readonly description = '提供文本朗读能力，使用小米 Mimo TTS API 将文本转换为语音并播放。';

  private config: Required<Pick<TTSFeatureConfig, 'api' | 'style' | 'output' | 'triggers'>>;
  private client: OpenAI;
  private state: TTSState;
  private _packageInfo: PackageInfo | null = null;

  constructor(config: TTSFeatureConfig = {}) {
    // 初始化状态
    this.state = {
      enabled: true,
      lastUtteranceId: null,
      totalUtterances: 0,
    };

    // 获取 API Key
    const apiKey = config.api?.apiKey ?? process.env.XIAOMI_TTS_API_KEY ?? '';
    if (!apiKey) {
      console.warn('[TTSFeature] ⚠ API Key not found. Please set XIAOMI_TTS_API_KEY environment variable or pass apiKey in config.');
    }

    // 初始化 OpenAI 客户端
    this.client = new OpenAI({
      apiKey,
      baseURL: config.api?.baseURL ?? DEFAULT_API_BASE_URL,
    });

    // 合并配置
    this.config = {
      api: {
        apiKey,
        baseURL: config.api?.baseURL ?? DEFAULT_API_BASE_URL,
        model: config.api?.model ?? DEFAULT_MODEL,
        format: config.api?.format ?? DEFAULT_FORMAT,
        voice: config.api?.voice ?? DEFAULT_VOICE,
        temperature: config.api?.temperature ?? DEFAULT_TEMPERATURE,
      },
      style: {
        systemPrompt: config.style?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        styleTags: config.style?.styleTags ?? DEFAULT_STYLE_TAGS,
        lang: config.style?.lang ?? 'zh',
      },
      output: {
        autoPlay: config.output?.autoPlay ?? true,
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

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  getTemplateNames(): string[] {
    return [];
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    console.log(
      `[TTSFeature] Initialized with model=${this.config.api.model}, voice=${this.config.api.voice}`
    );
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 清理资源
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
   * 检查消息是否包含工具调用
   */
  private messageHasToolCall(message: any): boolean {
    if (!message || !message.content) {
      return false;
    }

    // 字符串内容 - 没有工具调用
    if (typeof message.content === 'string') {
      return false;
    }

    // 数组内容 - 检查是否有 tool-use 或 tool-response
    if (Array.isArray(message.content)) {
      return message.content.some((part: any) =>
        part.type === 'tool-use' || part.type === 'tool-response'
      );
    }

    return false;
  }

  /**
   * 生成 TTS 音频并播放
   */
  private async generateAndPlay(text: string): Promise<TTSResult> {
    const utteranceId = randomUUID();
    const startTime = Date.now();

    try {
      // 调用小米 TTS API
      // 使用 any 绕过 OpenAI SDK 的类型检查（小米 API 扩展了标准格式）
      const completion = await this.client.chat.completions.create({
        model: this.config.api.model as any,
        messages: [
          { role: 'user', content: this.config.style.systemPrompt as string },
          {
            role: 'assistant',
            content: `<style>${this.config.style.styleTags}</style>${text}`
          }
        ],
        audio: {
          format: this.config.api.format as any,
          voice: this.config.api.voice as any
        },
        temperature: this.config.api.temperature,
        max_tokens: 4096
      } as any);

      const message = completion.choices[0].message;
      if (!message.audio?.data) {
        return {
          success: false,
          error: '没有音频数据返回'
        };
      }

      // 解码音频数据
      const audioBuffer = Buffer.from(message.audio.data, 'base64');

      // 如果启用自动播放，则播放音频
      if (this.config.output.autoPlay) {
        await this.playAudio(audioBuffer);
      }

      const duration = (Date.now() - startTime) / 1000;

      // 更新状态
      this.state.lastUtteranceId = utteranceId;
      this.state.totalUtterances += 1;

      return {
        success: true,
        duration
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Unknown error'
      };
    }
  }

  /**
   * 播放音频（使用 sound-play 包，与 audio-feedback-feature 相同）
   */
  private async playAudio(audioBuffer: Buffer): Promise<void> {
    // 使用项目本地目录
    const projectRoot = process.cwd();
    const ttsDir = path.join(projectRoot, '.agentdev', 'tts', 'temp');

    // 确保目录存在
    await fs.mkdir(ttsDir, { recursive: true });

    const ext = this.config.api.format === 'wav' ? 'wav' : 'mp3';
    const tempFile = path.join(ttsDir, `tts-${Date.now()}.${ext}`);

    // 写入音频文件
    await fs.writeFile(tempFile, audioBuffer);

    // 使用 sound-play 播放（等待播放完成后才返回）
    await (soundPlay as any).play(tempFile, 1.0);

    // 播放完成后清理文件
    fs.unlink(tempFile).catch(() => {});
  }

  /**
   * 提取模型输出的正文部分
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
   */
  @StepFinish
  async speakOnStepFinish(ctx: StepFinishedContext): Promise<void> {
    const triggers = this.config.triggers;
    if (!triggers?.autoEnabled || !this.state.enabled) {
      return;
    }

    // 检查是否只在非工具调用轮触发
    if (triggers.onlyOnNonToolCalls) {
      // 获取当前 step 的 assistant 消息
      const messages = ctx.context.getAll();
      const lastMessage = messages[messages.length - 1];

      // 如果最后一条消息不是 assistant，或者包含工具调用，则跳过
      if (!lastMessage || lastMessage.role !== 'assistant') {
        return;
      }

      // 检查是否包含工具调用
      const hasToolUse = this.messageHasToolCall(lastMessage);
      if (hasToolUse) {
        console.log('[TTSFeature] Tool call detected, skipping TTS');
        return;
      }
    }

    // 提取正文
    const text = this.extractMainResponse(ctx);
    if (!text) {
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

    // 生成并播放 TTS
    console.log(`[TTSFeature] Generating TTS for ${textToSpeak.length} characters...`);
    const result = await this.generateAndPlay(textToSpeak);

    if (result.success) {
      console.log(
        `[TTSFeature] ✓ TTS played successfully (${result.duration?.toFixed(2)}s)`
      );
    } else {
      console.warn(`[TTSFeature] ✗ TTS failed: ${result.error}`);
    }
  }
}

// 重新导出类型
export type { TTSFeatureConfig, TTSResult, TTSState };
