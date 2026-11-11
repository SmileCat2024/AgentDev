/**
 * Handoff-Seed Feature 类型定义（ticket 006 自 Claw context-handoff-seed 下沉）。
 */

import type { JsonValue } from '../../core/types.js';

export interface HandoffSeedMessage {
  role: string;
  content: string;
  turn?: number | null;
  toolCalls?: Array<{ name: string; arguments: string; id: string }>;
  toolCallId?: string;
  reasoning?: string;
  thinkingBlocks?: Array<{ thinking: string; signature: string }>;
  images?: Array<{ path?: string; base64?: string; mediaType?: string; source?: string }>;
  source?: string;
  tag?: JsonValue;
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

/**
 * seed 注入事务末尾追加的宿主消息（如接续校准提醒）。
 *
 * 注入与 seed 同事务确定性发生（isFirstCall && 未注入过），不依赖任何
 * 运行时探测；无 seed 内容的 runtime 不走注入路径，appendix 自然不触发。
 * 落账 source 恒为本 feature（框架 context 代理按注入者强制标记 owner，
 * 声明其他 source 会被覆盖）；内容归属（如 [工程素养] 前缀）由正文自表达。
 */
export interface HandoffSeedAppendix {
  /** 注入正文（完整文本，含任何体系前缀，由宿主组装）。 */
  content: string;
}

export interface HandoffSeedFeatureConfig {
  handoff: HandoffSeedPayload;
  /** seed 与重要文件/技能重载注入完成后，末尾追加一条 system 消息（tag='reminder'）。 */
  appendix?: HandoffSeedAppendix;
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
