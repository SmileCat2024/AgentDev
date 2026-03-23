/**
 * TTS Feature 类型定义
 */

/**
 * TTS Feature 配置选项
 */
export interface TTSFeatureConfig {
  /**
   * 小米 TTS API 配置
   */
  api?: {
    /**
     * API Key
     * 默认：从环境变量 XIAOMI_TTS_API_KEY 读取
     */
    apiKey?: string;

    /**
     * Base URL
     * 默认：https://api.xiaomimimo.com/v1
     */
    baseURL?: string;

    /**
     * 模型名称
     * 默认：mimo-v2-tts
     */
    model?: string;

    /**
     * 音频格式
     * 默认：mp3
     */
    format?: 'mp3' | 'wav' | 'pcm';

    /**
     * 音色
     * 默认：default_zh
     */
    voice?: string;

    /**
     * 温度参数
     * 默认：0.7
     */
    temperature?: number;
  };

  /**
   * TTS 风格配置
   */
  style?: {
    /**
     * 系统提示词（角色设定）
     * 默认：香港女生
     */
    systemPrompt?: string;

    /**
     * 风格标签
     * 示例：开心 粤语 撒娇
     */
    styleTags?: string;

    /**
     * 语言
     * 默认：zh
     */
    lang?: 'zh' | 'en' | 'yue';
  };

  /**
   * 音频输出配置
   */
  output?: {
    /**
     * 是否自动播放生成的音频
     * 默认：true
     */
    autoPlay?: boolean;
  };

  /**
   * TTS 触发条件
   */
  triggers?: {
    /**
     * 是否启用自动朗读
     * 默认：true
     */
    autoEnabled?: boolean;

    /**
     * 最小文本长度（字符数）
     * 短于此长度的文本不会朗读
     * 默认：10
     */
    minLength?: number;

    /**
     * 最大文本长度（字符数）
     * 长于此长度的文本会被截断
     * 默认：1000
     */
    maxLength?: number;

    /**
     * 是否只在非工具调用轮触发
     * 默认：true
     */
    onlyOnNonToolCalls?: boolean;
  };
}

/**
 * TTS 生成结果
 */
export interface TTSResult {
  success: boolean;
  duration?: number;
  error?: string;
}

/**
 * TTS 内部状态（用于快照和恢复）
 */
export interface TTSState {
  enabled: boolean;
  lastUtteranceId: string | null;
  totalUtterances: number;
}
