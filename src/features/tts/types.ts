/**
 * TTS Feature 类型定义
 */

/**
 * TTS Feature 配置选项
 */
export interface TTSFeatureConfig {
  /**
   * Python 可执行文件路径
   * 默认：项目 .venv 中的 Python 或系统 PATH 中的 python
   */
  pythonPath?: string;

  /**
   * Python 额外参数（如 uv run）
   * 例如：['run', '--with', 'kokoro', '--with', 'soundfile']
   */
  pythonArgs?: string[];

  /**
   * 是否在初始化时检查 Python 环境
   * 默认：true
   */
  checkPythonEnv?: boolean;

  /**
   * TTS 模型配置
   */
  model?: {
    /**
     * 默认声音 ID
     * 中文常用：zf_xiaobei, zf_xiaoxiao, zf_xiaomei
     * 英文常用：af_bella, af_heart
     * 默认：zf_xiaobei
     */
    voice?: string;

    /**
     * 语言代码
     * 'zh'（中文优先） 或 'a'/'en'（英文优先）
     * 默认：zh
     */
    lang?: string;

    /**
     * 语速倍率
     * 0.8~1.5 之间合理
     * 默认：1.0
     */
    speed?: number;
  };

  /**
   * 音频输出配置
   */
  output?: {
    /**
     * 输出目录
     * 默认：.agentdev/tts
     */
    outputDir?: string;

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
     * 是否启用自动朗读（非工具调用轮）
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
     * 是否只在非结束轮触发
     * true: 只在没有工具调用时朗读
     * false: 所有响应都朗读
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
  outputPath?: string;
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
