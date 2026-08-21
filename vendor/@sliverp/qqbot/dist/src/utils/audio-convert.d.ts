/**
 * 将 SILK/AMR 语音文件转换为 WAV 格式
 *
 * @param inputPath 输入文件路径（.amr / .silk / .slk）
 * @param outputDir 输出目录（默认与输入文件同目录）
 * @returns 转换后的 WAV 文件路径，失败返回 null
 */
export declare function convertSilkToWav(inputPath: string, outputDir?: string): Promise<{
    wavPath: string;
    duration: number;
} | null>;
/**
 * 判断是否为语音附件（根据 content_type 或文件扩展名）
 */
export declare function isVoiceAttachment(att: {
    content_type?: string;
    filename?: string;
}): boolean;
/**
 * 格式化语音时长为可读字符串
 */
export declare function formatDuration(durationMs: number): string;
export declare function isAudioFile(filePath: string): boolean;
export interface TTSConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
    /** Azure OpenAI 风格：使用 api-key header 而非 Bearer token */
    authStyle?: "bearer" | "api-key";
    /** 附加在 URL 后的查询参数，如 Azure 的 api-version */
    queryParams?: Record<string, string>;
    /** 自定义速度（默认不传） */
    speed?: number;
}
export declare function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null;
export declare function textToSpeechPCM(text: string, ttsCfg: TTSConfig): Promise<{
    pcmBuffer: Buffer;
    sampleRate: number;
}>;
export declare function pcmToSilk(pcmBuffer: Buffer, sampleRate: number): Promise<{
    silkBuffer: Buffer;
    duration: number;
}>;
export declare function textToSilk(text: string, ttsCfg: TTSConfig, outputDir: string): Promise<{
    silkPath: string;
    silkBase64: string;
    duration: number;
}>;
/**
 * 将本地音频文件转换为 QQ Bot 可上传的 Base64
 *
 * QQ Bot API 支持直传 WAV、MP3、SILK 三种格式，其他格式仍需转换。
 * 转换策略（参考 NapCat/go-cqhttp/Discord/Telegram 的做法）：
 *
 * 1. WAV / MP3 / SILK → 直传（跳过转换）
 * 2. 有 ffmpeg → ffmpeg 万能解码为 PCM → silk-wasm 编码
 *    支持: ogg, opus, aac, flac, wma, m4a, pcm 等所有 ffmpeg 支持的格式
 * 3. 无 ffmpeg → WASM fallback（仅支持 pcm, wav）
 *
 * @param directUploadFormats - 自定义直传格式列表，覆盖默认值。传 undefined 使用 QQ_NATIVE_UPLOAD_FORMATS
 */
export declare function audioFileToSilkBase64(filePath: string, directUploadFormats?: string[]): Promise<string | null>;
/**
 * 等待文件就绪（轮询直到文件出现且大小稳定）
 * 用于 TTS 生成后等待文件写入完成
 *
 * @param filePath 文件路径
 * @param timeoutMs 最大等待时间（默认 2 分钟）
 * @param pollMs 轮询间隔（默认 500ms）
 * @returns 文件大小（字节），超时或文件始终为空返回 0
 */
export declare function waitForFile(filePath: string, timeoutMs?: number, pollMs?: number): Promise<number>;
