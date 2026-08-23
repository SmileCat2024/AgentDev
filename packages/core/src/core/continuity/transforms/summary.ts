/**
 * Summary 官方变换（ticket 006 新增）。
 *
 * 基于 005 的 `TransformContext.llm` 进程内注入，对源会话快照做一次摘要变换，
 * 产出 SuccessorSeed（summary-message seed）。提示词以 Claw
 * `claude-compact-prompts.js` 为蓝本。
 *
 * 不移植 Claw 的 mirror 子进程管线——那是 Claw 装配细节（模型配置来源），
 * 由 Claw 侧决定何时切换到进程内注入。
 *
 * 组合语义（ticket 006 收敛定案）：不做通用 compose 组合子机制。官方单实现
 * 先落——`TrimTranscriptWithSummaryTransformation` 把「trim 裁剪 + 追加摘要」
 * 硬编码混合语义 1:1 迁移（对齐 Claw `trim-transcript-with-summary`）。
 */

import type { Message, LLMResponse } from '../../types.js';
import type { AgentSessionSnapshot } from '../../session-store.js';
import type {
  SessionTransformation,
  TransformInput,
  TransformContext,
  SuccessorSeed,
  SessionSeedMessage,
} from '../index.js';
import {
  DEFAULT_EXPORT_POLICY,
  normalizeExportPolicy,
  buildTrimmedSeedMessages,
  HANDOFF_SCHEMA_VERSION,
} from './trim-transcript.js';

// ============ 提示词（以 claude-compact-prompts.js 为蓝本） ============

const BASE_SUMMARY_PROMPT = `你的任务是为当前对话创建一份详细摘要，重点关注用户的明确请求和该 agent 之前采取的行动。
这份摘要应保留恢复工作所需的任务连续性关键信息。

按时间顺序分析对话：

1. 识别用户的明确请求和意图
2. 保留用户较为模糊的术语概念与情况表述，不做过多推测与转述
3. 识别该 agent 的方法和关键决策，以及用户的反馈，特别注意该 agent 曾理解有误、或后续改变方向的用户反馈
4. 记录与用户探讨的重要结论，以及最终放弃、或纠正某些决策的原因
5. 记录当前讨论要点之于整个项目的层次，以及重要的技术概念、文件名、代码模式
6. 记录遇到的错误及修复方式

摘要使用以下十段式结构：

1. 主要请求与意图
2. 用户观点表态与方向调整
3. 关键技术概念
4. 重要结论与决策
5. 参考文件、技能与代码段
6. 错误与修复
7. 问题解决过程
8. 待办事项
9. 当前工作
10. 可选的下一步

摘要控制在 3000 个词以内，优先使用要点而非段落。`;

const TRIM_APPENDED_SUMMARY_PROMPT = `你的任务是为当前对话创建一份详细摘要，留存其中的关键信息，并让摘要本身结构清晰、脉络连贯、可以独立阅读。

需要注意：在摘要生成后，工具调用记录中的参数细节和返回内容可能不会继续保留；在这次精简场景中，工具活动通常只保留调用签名。用户消息和 Agent 的主要回复则通常仍会保留。因此，工具返回中出现过的完整标识符、文件内容与代码事实、统计数字、命令与查询的实际输出、报错原文、外部资料中的具体机制等信息，需要在摘要中重新落地，不能假定读者还能从工具记录中找回。

摘要应同时承担两类内容：一类是工具调用带来的具体信息，另一类是对话脉络、方向变化、决策和结论的概括。后者可以适度复述，使摘要流畅、完整、独立可读；前者则应覆盖工具呈现的不同信息维度，而不要只围绕某一条显眼的主线进行筛选。信息是否保留，主要依据它本身的具体程度、独立价值和对理解会话的帮助，不要过早假定某个维度之后不会用到。

按时间顺序分析对话，重点关注：

1. 工具调用中获得的重要事实、技术信息、代码机制、文件内容、测试结果和外部资料。这些内容在精简后可能无处可查，应从多个相关维度尽量完整地保留。
2. 重要的文件名、路径、函数、类型、数据结构、关键参数、代码位置、错误信息、数字、版本、命令结果等具体信息，一律使用完整值，例如完整的 ID、哈希和路径，不要用省略号或“等 N 项”带过。对于实现细节和机制说明，可以适当保留具体的定位信息。
3. 对于已经在 Agent 回复中明确表达的重要结论、技术判断和决策，可以概括复述，以保持叙事连贯；同时记录其中主要存在于工具调用中的事实、证据和必要依据。
4. 用户对方向的重要反馈和纠正，尤其是曾经理解有误、后来改变方向的部分；可以用概括方式复述，让读者能够理解对话如何发展。
5. 已经尝试但被否定或放弃的重要方向，以及不再沿用这些方向的原因。普通操作失误或偶发错误通常无需记录，除非它提供了一个独立的技术事实、边界或判断依据。
6. 已经实际完成的重要修改、操作和状态变化，以及仍然存在的重要问题。注意区分计划、尝试、完成和验证；验证结果应落到具体数字或其他可核对的最终值。
7. 如果某个结论或机制只能概括表达，而原始工具信息中还有可能需要重新确认的细节，应说明缺少什么，并给出完整的定位信息，例如完整路径、完整 ID 或可复查的命令。
8. 对外部调研和参考资料，优先保留资料本身提供的具体机制、实现方式、差异和关键事实，不要只记录最终评价或笼统结论。对于较长的工具输出，提炼其中多个独立且有代表性的事实和关键片段，而不是只保留一个总结性结论。

在提供最终摘要之前，先用 <analysis> 标签进行一次信息对照：检查准备写入的具体标识符、数字、路径、输出片段和其他事实，区分哪些信息已经在用户消息或 Agent 回复中完整出现，哪些信息主要或仅存在于工具调用中。对话中已经存在的信息可以用概括方式复述；工具调用中出现的具体信息则应以完整、可核对的形式写入摘要。

摘要使用自然的 Markdown 结构，根据实际内容组织，例如：

## 重要发现与技术信息

## 关键证据与实现细节

## 结论背后的补充依据

## 已排除的问题与方向

## 修改、执行结果与当前状态

## 需要重新查看的细节与位置

不要求所有章节都出现，也不要为了填充结构重复内容。

摘要应覆盖工具调用带来的具体信息和对话脉络的必要概括。对话已有的完整论述不必逐字重现，但可以提炼其发展过程、方向变化和结论，使摘要读起来完整自然；工具信息则应注意覆盖不同维度，并保留其中能够独立说明事实的细节。

不要为了完整而记录所有工具调用、所有错误或完整的问题解决过程。纯粹的中间操作过程、偶发错误、与任何结论无关的临时输出可以省略；已经被后续结果取代的中间值可以不记，但最终值和独立的技术事实应保留。

摘要控制在 3000 个词以内，优先使用要点而非长段落；长度以信息完整和结构清晰为准。`;

export interface SummaryPromptOptions {
  /** 附加压缩指令（追加到提示词末尾）。 */
  additionalInstructions?: string;
  /** true 时使用 trim-appended 专用提示词（组合语义用）。 */
  trimAppended?: boolean;
  /** exploration 会话使用三段式探索提示词。 */
  exploration?: boolean;
}

/** 生成摘要提示词（对齐 claude-compact-prompts.js 的 buildClaudeCompactPrompt）。 */
export function buildSummaryPrompt(options: SummaryPromptOptions = {}): string {
  const extra = typeof options.additionalInstructions === 'string' && options.additionalInstructions.trim()
    ? `## 额外压缩指令\n${options.additionalInstructions.trim()}`
    : '';
  if (options.trimAppended) {
    return [TRIM_APPENDED_SUMMARY_PROMPT, extra].filter(Boolean).join('\n');
  }
  return [BASE_SUMMARY_PROMPT, extra].filter(Boolean).join('\n');
}

// ============ 文本清洗 / 摘要提取（对齐 claude-compact-prompts.js） ============

function cleanMultilineText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());
  const compacted: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1;
      if (blankRun <= 1) {
        compacted.push('');
      }
      continue;
    }
    blankRun = 0;
    compacted.push(line);
  }
  return compacted.join('\n').trim();
}

/** 从 LLM 原始响应中剥离 <analysis> 与 <summary> 包裹，得到纯摘要文本。 */
export function stripCompactAnalysis(rawText: string): string {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return '';

  const withoutAnalysis = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summaryBody = summaryMatch ? summaryMatch[1].trim() : withoutAnalysis;
  return summaryBody.replace(/\n{3,}/g, '\n\n').trim();
}

// ============ 扫描重要文件 / 技能（对齐 claude-compact-prompts.js） ============

export interface ScanFilesAndSkillsResult {
  files: string[];
  skills: string[];
  fileRanges: Record<string, string>;
}

/** 从原始消息中扫描 read/write/edit 与 invoke_skill 调用，收集重要文件、技能与行号范围。 */
export function scanFilesAndSkills(rawMessages: any[]): ScanFilesAndSkillsResult {
  const files = new Set<string>();
  const skills = new Set<string>();
  const fileRanges: Record<string, string> = {};
  for (const message of rawMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    for (const tc of message.toolCalls) {
      const name = typeof tc?.name === 'string' ? tc.name : '';
      const args = tc?.arguments && typeof tc.arguments === 'object' ? tc.arguments : {};
      if ((name === 'read' || name === 'write' || name === 'edit') && typeof args.filePath === 'string') {
        files.add(args.filePath);
      }
      if (name === 'read' && typeof args.filePath === 'string') {
        const offset = typeof args.offset === 'number' ? args.offset : (typeof args.line === 'number' ? args.line : 0);
        const limit = typeof args.limit === 'number' ? args.limit : 0;
        if (offset > 0 || limit > 0) {
          const start = Math.max(1, offset || 1);
          const end = limit > 0 ? start + limit - 1 : start;
          fileRanges[args.filePath] = `${start}-${end}`;
        }
      }
      if (name === 'invoke_skill' && typeof args.skill === 'string') {
        skills.add(args.skill);
      }
    }
  }
  return { files: [...files], skills: [...skills], fileRanges };
}

// ============ 策略归一化 ============

export interface SummaryExportPolicy {
  strategy: string;
  summaryShape: string;
  maxAttempts: number;
  additionalInstructions: string;
}

export function normalizeSummaryPolicy(rawPolicy: Record<string, unknown> = {}): SummaryExportPolicy {
  return {
    strategy: 'summarized-nine-section',
    summaryShape: 'claude-nine-section-v1',
    maxAttempts: Number.isFinite(rawPolicy?.maxAttempts)
      ? Math.max(1, Math.min(5, Number(rawPolicy.maxAttempts)))
      : 3,
    additionalInstructions: cleanMultilineText(rawPolicy?.additionalInstructions),
  };
}

// ============ 种子消息构建 ============

/**
 * 构建 summary 种子消息（对齐 summarized-handoff / trim-appended-summary）。
 * 返回 role:'system' 的摘要消息。
 */
export function buildSummarySeedMessage(summaryText: string): SessionSeedMessage {
  const body = cleanMultilineText(summaryText);
  return {
    role: 'system',
    content: [
      '以下是前一会话的工作摘要，用于延续同一任务上下文。',
      '摘要涵盖前一轮对话的关键内容。',
      '',
      '摘要：',
      body,
      '',
      '请基于此摘要继续工作，无需要求用户重复陈述背景。',
    ].join('\n'),
    turn: 0,
  };
}

// ============ LLM 调用 ============

function extractMessages(snapshot: AgentSessionSnapshot): any[] {
  return Array.isArray(snapshot?.runtime?.context?.messages)
    ? snapshot.runtime.context.messages
    : [];
}

/**
 * 身份澄清前缀：摘要请求携带原会话完整记录注入，需明确告知模型
 * 这是一份已存在的会话记录而非其真实交互，防止模型代入原 agent 身份
 * （尤其当记录中途残留原身份相关内容时）。
 */
const SUMMARY_ROLE_PREAMBLE = `以下呈现的是一份已经存在的会话记录（transcript）。注意：这份记录不是你与任何人的真实交互，你也不是该会话中的任何角色——不要代入其中 agent 的身份，不要延续其中的任务或对话。你的唯一任务是：以旁观者身份，按本提示的要求为这份完整记录撰写摘要。`;

/** 结尾锚定：标记会话记录到此为止，其上全部内容才是概括对象。 */
const SUMMARY_CLOSING_ANCHOR = '会话记录到此为止。请基于以上全部记录，按照系统提示的要求输出摘要；不要续写会话，不要扮演其中的任何角色。';

/** 单条工具返回注入摘要请求的最大字符数（长输出截断，防止撑爆上下文）。 */
const TOOL_RESULT_MAX_CHARS = 1200;

function truncateToolResult(content: unknown): string {
  const text = typeof content === 'string' ? content : '';
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…(返回已截断，原始长度 ${text.length} 字符)`;
}

/** 调用签名（与 folded-tool-activity 折叠行同格式）：read/edit/write 取文件名，invoke_skill 取技能名，其余用工具名。 */
function toolCallSignature(call: any): string {
  const name = typeof call?.name === 'string' && call.name ? call.name : 'tool';
  let args = call?.arguments ?? call?.args;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    const filePath = typeof record.filePath === 'string' ? record.filePath : '';
    if ((name === 'read' || name === 'edit' || name === 'write') && filePath) {
      return `${name}(${filePath.split(/[\\/]/).pop() || filePath})`;
    }
    if (name === 'invoke_skill' && typeof record.skill === 'string') {
      return `invoke_skill(${record.skill})`;
    }
  }
  return name;
}

function buildChatMessages(snapshot: AgentSessionSnapshot, prompt: string): Message[] {
  const rawMessages = extractMessages(snapshot);
  const sys: Message = { role: 'system', content: `${SUMMARY_ROLE_PREAMBLE}\n\n${prompt}` };
  // 剥离会话头部的静态 system 前缀（身份设定、环境文档、全局约束），
  // 由摘要指令替换其成为唯一 system 前缀，避免模型在摘要请求中继续扮演原 agent。
  // 对话中途注入的 system（folded-tool-activity、前轮摘要 seed、任务状态等）
  // 不在头部前缀内，作为摘要素材原样保留。
  let headEnd = 0;
  while (headEnd < rawMessages.length && rawMessages[headEnd]?.role === 'system') headEnd++;

  // 工具返回配对表：toolCallId → 调用签名，让摘要模型能把每条返回对应到具体调用。
  // 补偿型摘要的增量信息（文件内容、命令输出、报错原文）都在工具返回里，
  // 必须随对话主体一起进入摘要请求，否则模型只能依赖 assistant 的转述。
  const callSignatures = new Map<string, string>();
  for (const m of rawMessages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls) {
      const id = typeof tc?.id === 'string' ? tc.id : '';
      if (id) callSignatures.set(id, toolCallSignature(tc));
    }
  }

  const history: Message[] = [];
  for (const m of rawMessages.slice(headEnd)) {
    if (m?.role === 'tool') {
      const signature = (typeof m?.toolCallId === 'string' && callSignatures.get(m.toolCallId)) || '未匹配调用';
      history.push({
        role: 'system',
        content: `[工具返回 ${signature}]\n${truncateToolResult(m?.content)}`,
        tag: 'tool-result',
      } as Message);
      continue;
    }
    history.push({
      role: m?.role,
      content: typeof m?.content === 'string' ? m.content : '',
      turn: m?.turn,
      ...(m?.tag ? { tag: m.tag } : {}),
    } as Message);
  }
  const closing: Message = { role: 'user', content: SUMMARY_CLOSING_ANCHOR };
  return [sys, ...history, closing].filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant');
}

/** 调用 llm 生成摘要文本（空工具集、非流式）。失败时抛出。 */
export async function generateSummaryText(
  ctx: TransformContext,
  snapshot: AgentSessionSnapshot,
  prompt: string,
): Promise<string> {
  const messages = buildChatMessages(snapshot, prompt);
  const response: LLMResponse = await ctx.llm.chat(messages, [], { noStream: true });
  const text = stripCompactAnalysis(response.content ?? '');
  if (!text) {
    throw new Error('Summary LLM returned an empty summary');
  }
  return text;
}

// ============ Transformation 契约实现 ============

export interface SummaryTransformationOptions {
  defaultPolicy?: Record<string, unknown>;
}

/**
 * Summary 变换：对源会话快照做摘要变换，产出 SuccessorSeed。
 * 摘要由 `TransformContext.llm` 进程内生成（对齐 ADR-0002 Q3=A）。
 */
export class SummaryTransformation implements SessionTransformation {
  readonly id = 'agentdev.summary';

  private readonly defaultPolicy: Record<string, unknown>;

  constructor(options: SummaryTransformationOptions = {}) {
    this.defaultPolicy = options.defaultPolicy ?? {};
  }

  async transform(input: TransformInput, ctx: TransformContext): Promise<SuccessorSeed> {
    const snapshot: AgentSessionSnapshot = input.sourceSnapshot;
    const policy = normalizeSummaryPolicy({ ...this.defaultPolicy, ...(input.policy ?? {}) });
    const prompt = buildSummaryPrompt({ additionalInstructions: policy.additionalInstructions });
    const summaryText = await generateSummaryText(ctx, snapshot, prompt);
    const scanned = scanFilesAndSkills(extractMessages(snapshot));

    return {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      seedMessages: [buildSummarySeedMessage(summaryText)],
      importantFiles: scanned.files,
      importantSkills: scanned.skills,
      fileRanges: scanned.fileRanges,
      meta: {
        compilerVersion: 'summarized-nine-section-v1',
        seedKind: 'summary-message',
        mode: policy.strategy,
        summaryShape: policy.summaryShape,
        policy,
        summaryText,
        summaryChars: summaryText.length,
      },
    };
  }
}

export interface TrimTranscriptWithSummaryOptions {
  /** 注入自定 trim 初始策略（组合语义，硬编码追加摘要）。 */
  trimPolicy?: Record<string, unknown>;
  /** 摘要生成时的附加指令。 */
  additionalInstructions?: string;
}

/**
 * Trim-Transcript-with-Summary 官方单实现（ticket 006 收敛定案）。
 *
 * 组合语义 1:1 迁移自 Claw `trim-transcript-with-summary`：先对源会话做
 * trim 裁剪（默认策略），再用 `TransformContext.llm` 生成摘要，并把摘要
 * 种子消息追加到裁剪后的种子消息尾部。不做通用 compose 组合子机制。
 */
export class TrimTranscriptWithSummaryTransformation implements SessionTransformation {
  readonly id = 'agentdev.trim-transcript-with-summary';

  private readonly options: TrimTranscriptWithSummaryOptions;

  constructor(options: TrimTranscriptWithSummaryOptions = {}) {
    this.options = options;
  }

  async transform(input: TransformInput, ctx: TransformContext): Promise<SuccessorSeed> {
    const snapshot: AgentSessionSnapshot = input.sourceSnapshot;
    const rawMessages = extractMessages(snapshot);

    // 1) trim 裁剪
    const trimPolicy = normalizeExportPolicy({ ...DEFAULT_EXPORT_POLICY, ...(this.options.trimPolicy ?? {}), ...(input.policy ?? {}) });
    const { seedMessages, stats } = buildTrimmedSeedMessages(rawMessages, trimPolicy);

    // 2) 摘要生成（trimAppended 提示词）
    const prompt = buildSummaryPrompt({
      trimAppended: true,
      additionalInstructions: this.options.additionalInstructions,
    });
    const summaryText = await generateSummaryText(ctx, snapshot, prompt);
    const scanned = scanFilesAndSkills(rawMessages);

    // 3) 摘要种子消息追加到末尾
    const combinedSeedMessages = [
      ...seedMessages,
      buildSummarySeedMessage(summaryText),
    ];

    return {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      seedMessages: combinedSeedMessages,
      importantFiles: scanned.files,
      importantSkills: scanned.skills,
      fileRanges: scanned.fileRanges,
      meta: {
        compilerVersion: 'trim-transcript-v1',
        seedKind: 'message-replay',
        mode: 'trim-transcript-with-summary',
        trimPolicy,
        trimStats: stats,
        summaryText,
        summaryChars: summaryText.length,
        appendedSummary: {
          summaryText,
          importantFiles: scanned.files,
          importantSkills: scanned.skills,
          fileRanges: scanned.fileRanges,
        },
      },
    };
  }
}
