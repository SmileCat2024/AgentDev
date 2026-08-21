/**
 * Session Continuity 契约层（ticket 005）。
 *
 * 会话接续被定义为对 Session 施加一次变换（Transformation），产出下一个
 * Session 的种子（SuccessorSeed）。变换是框架对外部宿主开放的扩展点：trim、
 * summary 等只是官方参考实现，宿主可整体替换为任意自定义变换。
 *
 * 本模块只定义契约类型（窄契约），零运行时行为。
 *
 * 两级结构（ADR-0002 Q1=C）：
 * - 窄契约：`SessionTransformation`（`transform(sourceSnapshot, policy) →
 *   SuccessorSeed`），本模块核心。
 * - 宽边界编排（successor 创建/接力收口）：作为框架可替换默认实现，不属本模块。
 *
 * 边界约定：
 * - 变换的读写统一以 session-store 的快照类型为契约级消费面（Q2=C），
 *   不引入会话列表/分支/归档管理等宿主职责。
 * - 摘要类变换的 LLM 基座经 `TransformContext.llm` 由宿主在进程内注入
 *   （Q3=A），不起完整 agent 的重基座，也不预设工具调用能力。
 * - 变换产物 SuccessorSeed 以 Claw 现行 handoff JSON v1 为蓝本框架化，
 *   **不引入任何 Claw 私有概念**（prebuilt session、managed runtime 等）。
 */

import type { AgentSessionSnapshot } from '../session-store.js';
import type { LLMClient } from '../types.js';

/**
 * 变换输入 — 源会话快照 + 变换自定义策略面。
 *
 * `sourceSnapshot` 复用 session-store 的既有快照契约（Q2 契约级消费面），
 * 不引入宿主私有形态。`policy` 是变换自解释的扩展策略面，具体键值由各转换
 * 自定义，零语义在框架层。
 */
export interface TransformInput {
  /** 源会话快照（session-store 契约类型）。 */
  sourceSnapshot: AgentSessionSnapshot;
  /** 变换自定义策略面（每个变换自行解释，框架不预定义语义）。 */
  policy?: Record<string, unknown>;
}

/**
 * 变换上下文 — 宿主在调起变换时注入的进程内能力。
 *
 * 当前唯一注入项是 LLM 调用基座（`llm`），面向摘要类变换。复用框架既有的
 * 中性 `LLMClient` 抽象，不新增平行的 LLM 接口；摘要类变换以空工具集调用
 * 即可，无需工具调用等重能力（Q3=A）。
 *
 * 该面为开放面：后续记事本变换若确需其他能力（如磁盘读写、时钟），在此扩展，
 * 不在 `SessionTransformation` 签名上增加负担。
 */
export interface TransformContext {
  /** 宿主注入的进程内 LLM 调用能力（摘要类变换的执行基座）。 */
  llm: LLMClient;
}

/**
 * 特征连续性条目 — 待跨 session 转移的单个 Feature 状态。
 *
 * 以 Claw 现行 feature-continuity 协议的 entry 形态框架中性化：
 * `protocol` 为连续性协议标识（由申明的 Feature 自指），`state` 为特征自解释
 * 的可序列化状态，`importMode` 表示导入时合并还是整体替换。
 */
export interface SessionContinuityEntry {
  /** 目标 Feature 名。 */
  featureName: string;
  /** 连续性协议标识（Feature 自声明，框架不预定义取值）。 */
  protocol: string;
  /** 可序列化的 Feature 连续性状态。 */
  state: unknown;
  /**
   * 导入模式。
   * - 'replace'（默认）：用 seed 状态整体替换目标 Feature 当前状态。
   * - 'merge'：与新 runtime 状态合并导入。
   */
  importMode?: 'merge' | 'replace';
}

/**
 * 变换产物 — 下一个 Session 的种子。
 *
 * 以 Claw 现行 handoff JSON v1（`HANDOFF_SCHEMA_VERSION=1`）为蓝本框架化，
 * 保留版本字段，不携带 Claw 私有命名空间。
 *
 * 版本化定案（ticket 005 收敛项）：`schemaVersion` 必填；消费方遇到未知版本
 * 直接拒绝报错，**不做旧版本迁移逻辑**（最简方案，无兼容层）。
 */
export interface SuccessorSeed {
  /**
   * Seed 契约版本号。必填。
   *
   * 消费方必须校验：与自己支持的版本不一致（含未知版本）时直接拒绝报错，
   * 不静默降级、不做旧版本迁移。当前唯一已知版本为 1。
   */
  schemaVersion: number;
  /** 下一个 Session 的种子消息（消息回放式变换的产物）。 */
  seedMessages: SessionSeedMessage[];
  /** 跨 session 转移的 Feature 连续性状态（按需）。 */
  featureContinuity?: SessionContinuityEntry[];
  /** 被标记为重要的文件路径（供下一个 session 重新加载）。 */
  importantFiles?: string[];
  /** 被标记为重要的技能名。 */
  importantSkills?: string[];
  /** 各重要文件上次读取的行号/范围（便于增量提示，键为文件路径）。 */
  fileRanges?: Record<string, string>;
  /** 变换产物元信息（如来源会话、产生时间等，由变换作者自由填写）。 */
  meta?: Record<string, unknown>;
}

/**
 * 种子消息 — 变换产出的、供下一个 Session 回放的最小消息形态。
 *
 * 以框架 `Message` 为蓝本裁剪出的中性子集：只保留注入所需字段，不携带
 * `Message` 上与回放无关的执行/用量元数据，避免把框架运行时消息内部结构
 * 直接作为长期契约面。
 */
export interface SessionSeedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 来源轮次（用于对齐延续后的轮次计数）。 */
  turn?: number | null;
  /** 会话内工具调用重放所需：调用 id 与该调用参数。 */
  toolCallId?: string;
  toolCalls?: Array<{
    name: string;
    /** 序列化后的工具参数（与历史回放保持一致的字符串形态）。 */
    arguments: string;
    id: string;
  }>;
  /** 推理/思考内容（供保留连续思维时回放）。 */
  reasoning?: string;
  thinkingBlocks?: Array<{ thinking: string; signature: string }>;
  /** 图片附件（user / tool 消息的多模态输入）。 */
  images?: Array<{
    path?: string;
    base64?: string;
    mediaType?: string;
    source?: string;
  }>;
  /** 消息语义标签（如折叠活动、handoff-seed 等）。 */
  tag?: string;
}

/**
 * 会话接续变换（Transformation 窄契约）。
 *
 * 对源会话快照施加一次变换，产出下一个 Session 的种子。
 *
 * 注册/发现定案（ticket 005 收敛项）：不建 manifest / 注册表。官方实现以
 * 静态 import 引用，宿主显式装配时传入具体变换实例；宿主也可替换为任意
 * 自定义变换（接续是协议，策略只是插件）。
 */
export interface SessionTransformation {
  /** 变换唯一标识，如 'agentdev.trim-transcript'、'agentdev.summary'。 */
  id: string;
  /** 执行变换，返回下一个 Session 的种子。 */
  transform(input: TransformInput, ctx: TransformContext): Promise<SuccessorSeed>;
}
