import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type {
  AgentFeature,
  FeatureContext,
  FeatureInitContext,
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
    };
    return snapshot;
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as AudioFeedbackSnapshot;

    this.runtime.enabled = Boolean(state.enabled);
    this.runtime.volume = typeof state.volume === 'number' ? state.volume : 0.5;
    this.runtime.audioPath = typeof state.audioPath === 'string' ? state.audioPath : this.config.audioPath;
    this.runtime.playCount = typeof state.playCount === 'number' ? state.playCount : 0;
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
