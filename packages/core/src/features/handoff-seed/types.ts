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

export interface HandoffSeedSnapshot {
  injected: boolean;
}
