export interface AudioFeedbackConfig {
  /** 音频文件路径（相对于 feature 目录或绝对路径） */
  audioPath?: string;
  /** 失败时的音频文件路径（留空时使用内置 error.mp3） */
  errorAudioPath?: string;
  /** 是否启用音频反馈（默认：true） */
  enabled?: boolean;
  /** 音量（0-1，默认：0.5） */
  volume?: number;
}

export interface AudioFeedbackRuntimeState {
  enabled: boolean;
  volume: number;
  audioPath: string;
  errorAudioPath: string;
  playCount: number;
  activeMode: 'play-feedback' | 'mute-feedback' | null;
}

export interface AudioFeedbackSnapshot {
  enabled: boolean;
  volume: number;
  audioPath: string;
  errorAudioPath: string;
  playCount: number;
  activeMode: 'play-feedback' | 'mute-feedback' | null;
}
