/**
 * 富媒体标签预处理与纠错
 *
 * 小模型常见的标签拼写错误及变体，在正则匹配前统一修正为标准格式。
 */
/**
 * 预处理 LLM 输出文本，将各种畸形/错误的富媒体标签修正为标准格式。
 *
 * 标准格式：<qqimg>/path/to/file</qqimg>
 *
 * @param text LLM 原始输出
 * @returns 修正后的文本（如果没有匹配到任何标签则原样返回）
 */
export declare function normalizeMediaTags(text: string): string;
