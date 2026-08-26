/**
 * Feature 注入 system 消息的 reminder 包装。
 *
 * 无 source 的 system（agent 系统提示词）与有 source 的 system（Feature 注入，
 * 如 handoff-seed、partial-compact）在编译层分流：后者包为 <reminder> 嵌入
 * 最近的 user turn，而非混入顶层 system。已带 <reminder> 前缀的内容不重复包装。
 */
export function wrapReminder(text: string): string {
  const trimmed = text.trim();
  return /^<reminder[\s>]/.test(trimmed) ? trimmed : `<reminder>${trimmed}</reminder>`;
}
