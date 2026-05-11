import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type {
  AgentFeature,
  FeatureContext,
  FeatureInitContext,
  FeatureManifestDefinition,
  FeatureStateSnapshot,
} from '../../core/feature.js';
import type { CallFinishContext } from '../../core/lifecycle.js';
import { CallFinish } from '../../core/hooks-decorator.js';
import type {
  AudioFeedbackConfig,
  AudioFeedbackRuntimeState,
  AudioFeedbackSnapshot,
} from './types.js';
import soundPlay from 'sound-play';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Audio Feedback Feature
 * 
 * 在每次 call 完成时播放音频反馈，提供愉悦的交互体验
 */
export class AudioFeedbackFeature implements AgentFeature {
  readonly name = 'audio-feedback';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '在 call 完成时播放音频反馈，提供愉悦的交互体验。';

  private readonly config: Required<AudioFeedbackConfig>;
  private readonly runtime: AudioFeedbackRuntimeState = {
    enabled: true,
    volume: 0.5,
    audioPath: '',
    playCount: 0,
    activeMode: null,
  };
  private logger?: FeatureInitContext['logger'];

  constructor(config: AudioFeedbackConfig = {}) {
    this.config = {
      audioPath: config.audioPath ?? join(__dirname, 'media', 'success.mp3'),
      enabled: config.enabled ?? true,
      volume: config.volume ?? 0.5,
    };
    this.runtime.enabled = this.config.enabled;
    this.runtime.volume = this.config.volume;
    this.runtime.audioPath = this.config.audioPath;
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1 as const,
      settings: {
        properties: {
          enabled: {
            type: 'boolean',
            title: '默认启用',
            description: 'Agent 启动后是否默认播放提醒音频。',
            default: this.config.enabled,
          },
          volume: {
            type: 'number',
            title: '音量',
            description: '播放音量，范围 0 到 1。',
            default: this.config.volume,
            min: 0,
            max: 1,
            step: 0.05,
          },
          audioPath: {
            type: 'file',
            title: '音频文件路径',
            description: '可选自定义提醒音频文件路径；留空时使用 Feature 内置音频。',
            default: this.config.audioPath,
            accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac',
            placeholder: '选择自定义提醒音频文件',
          },
        },
      },
    };
  }

  getFlowModes() {
    return [
      {
        id: 'play-feedback',
        title: '播放提醒音',
        description: '当前阶段在每次 call 完成后播放提醒音频。',
      },
      {
        id: 'mute-feedback',
        title: '静音',
        description: '当前阶段关闭提醒音频播放。',
      },
    ];
  }

  getFlowVariables() {
    return [
      {
        key: 'audioFeedbackEnabled',
        type: 'boolean' as const,
        title: '音频提醒已启用',
        description: '当前 audio feedback feature 是否会在 call 结束时播放提醒音。',
        resolver: () => this.runtime.enabled,
      },
      {
        key: 'audioFeedbackPlayCount',
        type: 'number' as const,
        title: '提醒音播放次数',
        description: '当前会话中已经播放提醒音的次数。',
        resolver: () => this.runtime.playCount,
      },
    ];
  }

  applyFlowMode(modeId: string): void {
    if (modeId === 'mute-feedback') {
      this.runtime.activeMode = 'mute-feedback';
      this.setEnabled(false);
      return;
    }
    this.runtime.activeMode = 'play-feedback';
    this.setEnabled(true);
  }

  resetFlowModes(): void {
    this.runtime.activeMode = null;
    this.setEnabled(this.config.enabled);
  }

  /**
   * 公开 API：启用或禁用音频反馈
   */
  setEnabled(enabled: boolean): void {
    this.runtime.enabled = enabled;
    this.logger?.info('AudioFeedback enabled changed', { enabled });
  }

  isEnabled(): boolean {
    return this.runtime.enabled;
  }

  /**
   * 公开 API：设置音量
   */
  setVolume(volume: number): void {
    this.runtime.volume = Math.max(0, Math.min(1, volume));
    this.logger?.info('AudioFeedback volume changed', { volume: this.runtime.volume });
  }

  getPlayCount(): number {
    return this.runtime.playCount;
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;

    this.logger?.info('AudioFeedback initiated', {
      enabled: this.runtime.enabled,
      volume: this.runtime.volume,
      audioPath: this.runtime.audioPath,
    });
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    this.logger?.info('AudioFeedback destroyed');
  }

  captureState(): FeatureStateSnapshot {
    const snapshot: AudioFeedbackSnapshot = {
      enabled: this.runtime.enabled,
      volume: this.runtime.volume,
      audioPath: this.runtime.audioPath,
      playCount: this.runtime.playCount,
      activeMode: this.runtime.activeMode,
    };
    return snapshot;
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as AudioFeedbackSnapshot;

    this.runtime.enabled = Boolean(state.enabled);
    this.runtime.volume = typeof state.volume === 'number' ? state.volume : 0.5;
    this.runtime.audioPath = typeof state.audioPath === 'string' ? state.audioPath : this.config.audioPath;
    this.runtime.playCount = typeof state.playCount === 'number' ? state.playCount : 0;
    this.runtime.activeMode = state.activeMode === 'mute-feedback' || state.activeMode === 'play-feedback'
      ? state.activeMode
      : null;
  }

  /**
   * 核心功能：在 call 完成时播放音频
   */
  @CallFinish
  async playAudioOnCallFinish(ctx: CallFinishContext): Promise<void> {
    if (!this.runtime.enabled) {
      return;
    }

    try {
      this.runtime.playCount++;
      this.logger?.info('Playing audio feedback', {
        playCount: this.runtime.playCount,
        audioPath: this.runtime.audioPath,
      });

      // 使用 sound-play 播放音频
      await soundPlay.play(this.runtime.audioPath, this.runtime.volume);
    } catch (error) {
      this.logger?.error('Failed to play audio feedback', {
        error: error instanceof Error ? error.message : String(error),
        audioPath: this.runtime.audioPath,
      });
    }
  }
}
