/**
 * Handoff-Seed Feature 类型定义（ticket 006 自 Claw context-handoff-seed 下沉）。
 */

export interface HandoffSeedMessage {
  role: string;
  content: string;
  turn?: number | null;
  toolCalls?: Array<{ name: string; arguments: string; id: string }>;
  toolCallId?: string;
  reasoning?: string;
  thinkingBlocks?: Array<{ thinking: string; signature: string }>;
  images?: Array<{ path?: string; base64?: string; mediaType?: string; source?: string }>;
  tag?: string;
  /** 源会话原始消息时刻（毫秒）；缺省按注入时刻盖戳。 */
  timestamp?: number;
}

export interface HandoffSeedPayload {
  packageId?: string;
  sourceSessionId?: string;
  sourceSummary?: string;
  mode?: string;
  seedMessages?: HandoffSeedMessage[];
  importantFiles?: string[];
  importantSkills?: string[];
  fileRanges?: Record<string, string>;
  featureContinuity?: unknown;
}

export interface HandoffSeedFeatureConfig {
  handoff: HandoffSeedPayload;
}

/**
 * Handoff-Seed Feature 状态快照。
 *
 * injected 后的注入事实（ADR-0024 PR-3 marker 双落盘的注入侧）：与消息数组
 * 同盘同源，供流读取交叉校验（handoff 声明数 = featureStates 记录数 =
 * head 数组 seq 区间长度）。旧快照仅含 `{ injected: true }`，读取不报错。
 */
export interface HandoffSeedSnapshot {
  injected: boolean;
  /** 注入来源 handoff 包标识（与配置 handoff.packageId 一致）。 */
  packageId?: string;
  /** 实际注入的 seed 消息条数。 */
  seedCount?: number;
  /** 首条注入 seed 消息的 enriched sequence（含）。 */
  firstMessageSeq?: number;
  /** 末条注入 seed 消息的 enriched sequence（含）。 */
  lastMessageSeq?: number;
}
