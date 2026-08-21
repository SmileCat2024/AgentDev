/**
 * Session Continuity 官方变换实现（ticket 006）。
 *
 * trim / summary / trim-with-summary 三个官方参考实现。变换是框架对宿主
 * 开放的扩展点（ADR-0002：接续是协议，策略只是插件），宿主可直接实例化
 * 并装配，也可作蓝本编写自定义变换。
 */

export {
  DEFAULT_EXPORT_POLICY,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_COMPILER_VERSION,
  normalizeExportPolicy,
  buildTrimmedSeedMessages,
  TrimTranscriptTransformation,
} from './trim-transcript.js';
export type {
  TrimExportPolicy,
  TrimStats,
  TrimmedSeedResult,
  TrimTranscriptTransformationOptions,
} from './trim-transcript.js';

export {
  buildSummaryPrompt,
  stripCompactAnalysis,
  scanFilesAndSkills,
  normalizeSummaryPolicy,
  buildSummarySeedMessage,
  generateSummaryText,
  SummaryTransformation,
  TrimTranscriptWithSummaryTransformation,
} from './summary.js';
export type {
  SummaryPromptOptions,
  ScanFilesAndSkillsResult,
  SummaryExportPolicy,
  SummaryTransformationOptions,
  TrimTranscriptWithSummaryOptions,
} from './summary.js';
