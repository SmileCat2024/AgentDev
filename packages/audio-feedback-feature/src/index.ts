import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  AgentFeature,
  FeatureContext,
  FeatureInitContext,
  FeatureStateSnapshot,
} from 'agentdev';
import type { CallFinishContext } from 'agentdev';
import { CallFinish } from 'agentdev';
import type {
  AudioFeedbackConfig,
  AudioFeedbackRuntimeState,
  AudioFeedbackSnapshot,
} from './types.js';

const execFileAsync = promisify(execFile);
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

  private config: Required<AudioFeedbackConfig>;
  private readonly runtime: AudioFeedbackRuntimeState = {
    enabled: true,
    volume: 0.5,
    audioPath: '',
    errorAudioPath: '',
    playCount: 0,
    activeMode: null,
  };
  private logger?: FeatureInitContext['logger'];

  constructor() {
    this.config = {
      audioPath: join(__dirname, 'media', 'success.mp3'),
      errorAudioPath: join(__dirname, 'media', 'error.mp3'),
      enabled: true,
      volume: 0.5,
    };
    this.runtime.enabled = this.config.enabled;
    this.runtime.volume = this.config.volume;
    this.runtime.audioPath = this.config.audioPath;
    this.runtime.errorAudioPath = this.config.errorAudioPath;
  }

  getFeatureManifest() {
    return {
      schemaVersion: 1 as const,
      settings: {
        properties: {
          enabled: {
            type: 'boolean' as const,
            title: '默认启用',
            description: 'Agent 启动后是否默认播放提醒音频。',
            default: this.config.enabled,
          },
          volume: {
            type: 'number' as const,
            title: '音量',
            description: '播放音量，范围 0 到 1。',
            default: this.config.volume,
            min: 0,
            max: 1,
            step: 0.05,
          },
          audioPath: {
            type: 'file' as const,
            title: '音频文件路径',
            description: '可选自定义提醒音频文件路径；留空时使用 Feature 内置音频。',
            default: '',
            accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac',
            placeholder: '选择自定义提醒音频文件',
          },
          errorAudioPath: {
            type: 'file' as const,
            title: '失败音频文件路径',
            description: '可选自定义失败提醒音频文件路径；留空时使用 Feature 内置 error.mp3。',
            default: '',
            accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac',
            placeholder: '选择自定义失败提醒音频文件',
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
        type: 'boolean',
        title: '音频提醒已启用',
        description: '当前 audio feedback feature 是否会在 call 结束时播放提醒音。',
        resolver: () => this.runtime.enabled,
      },
      {
        key: 'audioFeedbackPlayCount',
        type: 'number',
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

    // Read behavior config from system featureConfig
    if (ctx.featureConfig && typeof ctx.featureConfig === 'object') {
      const fc = ctx.featureConfig as AudioFeedbackConfig;
      if (typeof fc.enabled === 'boolean') {
        this.config.enabled = fc.enabled;
        this.runtime.enabled = fc.enabled;
      }
      if (typeof fc.volume === 'number') {
        this.config.volume = fc.volume;
        this.runtime.volume = fc.volume;
      }
      if (typeof fc.audioPath === 'string' && fc.audioPath.trim()) {
        this.config.audioPath = fc.audioPath.trim();
        this.runtime.audioPath = fc.audioPath.trim();
      }
      if (typeof fc.errorAudioPath === 'string' && fc.errorAudioPath.trim()) {
        this.config.errorAudioPath = fc.errorAudioPath.trim();
        this.runtime.errorAudioPath = fc.errorAudioPath.trim();
      }
    }

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
      errorAudioPath: this.runtime.errorAudioPath,
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
    this.runtime.errorAudioPath = typeof state.errorAudioPath === 'string' ? state.errorAudioPath : this.config.errorAudioPath;
    this.runtime.playCount = typeof state.playCount === 'number' ? state.playCount : 0;
    this.runtime.activeMode = state.activeMode === 'mute-feedback' || state.activeMode === 'play-feedback'
      ? state.activeMode
      : null;
  }

  /**
   * 核心功能：在 call 完成时播放音频
   *
   * 根据 finishReason 区分成功 / 失败，播放不同音效：
   * - completed → 成功音
   * - interrupted / api_error / error / exception / max_steps → 失败音
   * - continuation → 不播放（call 暂停续接，非真正结束）
   */
  @CallFinish
  async playAudioOnCallFinish(ctx: CallFinishContext): Promise<void> {
    if (!this.runtime.enabled) {
      return;
    }

    if (ctx.finishReason === 'continuation') {
      return;
    }

    const isError = ctx.finishReason !== 'completed';
    const audioPath = isError ? this.runtime.errorAudioPath : this.runtime.audioPath;

    try {
      this.runtime.playCount++;
      this.logger?.info('Playing audio feedback', {
        playCount: this.runtime.playCount,
        audioPath,
        finishReason: ctx.finishReason,
        isError,
      });

      await this._playSound(audioPath);
    } catch (error) {
      this.logger?.error('Failed to play audio feedback', {
        error: error instanceof Error ? error.message : String(error),
        audioPath,
      });
    }
  }

  /**
   * 稳健的跨平台音频播放
   *
   * 替代第三方 sound-play 库。sound-play 在 Windows 上使用
   * `Start-Sleep -s $player.NaturalDuration.TimeSpan.TotalSeconds` 来
   * 等待播放结束，但 NaturalDuration 在 MediaPlayer.Open() 的异步加载
   * 完成前会抛出 InvalidOperationException，导致 PowerShell 进程提前
   * 退出、声音被截断——表现为"有时有声音有时没有"。
   *
   * 本方法在 Windows 上使用 Dispatcher.PushFrame 消息循环正确等待
   * MediaOpened 事件，确保媒体加载完毕后再读取时长。
   */
  private async _playSound(audioPath: string): Promise<void> {
    const volume = this.runtime.volume;

    if (process.platform === 'darwin') {
      // macOS: afplay 同步阻塞直到播放结束，本身可靠
      const macVolume = Math.min(2, volume * 2);
      await execFileAsync('afplay', ['-v', String(macVolume), audioPath]);
      return;
    }

    // Windows: 使用 WPF MediaPlayer + Dispatcher 消息泵
    const escapedPath = audioPath.replace(/'/g, "''");
    const psScript = [
      'Add-Type -AssemblyName PresentationCore',
      'Add-Type -AssemblyName WindowsBase',
      '$p = New-Object System.Windows.Media.MediaPlayer',
      '$frame = New-Object System.Windows.Threading.DispatcherFrame',
      '$timer = New-Object System.Windows.Threading.DispatcherTimer',
      '$timer.Interval = [TimeSpan]::FromMilliseconds(5000)',
      '$timer.Add_Tick({ $frame.Continue = $false })',
      '$p.Add_MediaOpened({ $frame.Continue = $false })',
      "$p.Open('" + escapedPath + "')",
      '$timer.Start()',
      '[System.Windows.Threading.Dispatcher]::PushFrame($frame)',
      '$timer.Stop()',
      '$p.Volume = ' + volume,
      '$p.Play()',
      '$dur = 2',
      'try { if ($p.NaturalDuration.HasTimeSpan) { $dur = $p.NaturalDuration.TimeSpan.TotalSeconds } } catch {}',
      'Start-Sleep -Seconds ([math]::Ceiling([math]::Max($dur, 0.5)))',
      '$p.Stop()',
      '$p.Close()',
    ].join('; ');

    await execFileAsync('powershell', ['-NoProfile', '-Command', psScript], {
      timeout: 15000,
      windowsHide: true,
    });
  }
}
