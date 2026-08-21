/**
 * Handoff-Seed Feature（ticket 006 自 Claw context-handoff-seed 下沉为框架标准 feature）。
 *
 * 当 runtime 从一次会话接续包启动时，在首个 CallStart 精确注入一次裁剪后的
 * handoff 转录（seed messages），并推进 `_callIndex` 避免轮次冲突。
 *
 * 随迁已解决的关键实现：
 * - typed Context API 注入（messages[] / enrichedMessages[] 同步）
 * - seed turn 对齐与 `_callIndex` 推进
 * - serialized tool message 重放（保留图片附件，不丢字段）
 *
 * env 传递约定（如 handoff 文件路径）留宿主，框架只提供 feature 类。
 */

import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, normalize } from 'path';
import type {
  AgentFeature,
  FeatureContext,
  FeatureInitContext,
  FeatureStateSnapshot,
} from '../../core/feature.js';
import type { HookDeclarations } from '../../core/hook-declarations.js';
import { CoreLifecycle } from '../../core/lifecycle.js';
import type { CallStartContext } from '../../core/lifecycle.js';
import type {
  HandoffSeedFeatureConfig,
  HandoffSeedPayload,
  HandoffSeedMessage,
  HandoffSeedSnapshot,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);

const MAX_FILE_CHARS = 8000;
const MAX_TOTAL_FILE_CHARS = 30000;
const MAX_SKILL_CHARS = 5000;
const MAX_TOTAL_SKILL_CHARS = 15000;

function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildTrimContextLabel(handoff: HandoffSeedPayload): string {
  const lines = [
    '## 会话续接元信息',
    '',
    '当前会话是从更早的对话裁剪续接而来。上方已注入裁剪后的完整对话历史。',
    '以下仅为该会话的任务元信息，不需要重新执行这些任务。',
  ];
  const sourceSessionId = cleanValue(handoff.sourceSessionId);
  if (sourceSessionId) {
    lines.push('', `来源会话：${sourceSessionId}`);
  }
  const sourceSummary = cleanValue(handoff.sourceSummary);
  if (sourceSummary) {
    lines.push('', sourceSummary);
  }
  return lines.join('\n');
}

function buildSummarySeedMessage(handoff: HandoffSeedPayload): string {
  const lines = [
    '## 上下文交接摘要',
    '',
    '以下压缩上下文来自更早的一次会话导出，用于让当前运行时继续同一个任务。',
  ];
  const sourceSessionId = cleanValue(handoff.sourceSessionId);
  if (sourceSessionId) {
    lines.push('', `来源会话：${sourceSessionId}`);
  }
  const sourceSummary = cleanValue(handoff.sourceSummary);
  if (sourceSummary) {
    lines.push('', sourceSummary);
  }
  return lines.join('\n');
}

/**
 * Inject a single seed message into Context via the typed API that keeps
 * both messages[] and enrichedMessages[] in sync.
 *
 * tool messages use addSerializedToolMessage() because their content is already
 * serialized in the handoff package and must be replayed without lossy parsing.
 */
function injectSeedMessage(
  context: CallStartContext['context'],
  message: HandoffSeedMessage,
  turn: number,
): void {
  const content = typeof message.content === 'string' ? message.content : '';
  const role = message.role;
  const tag = typeof message.tag === 'string' ? message.tag : undefined;

  if (role === 'system') {
    context.addSystemMessage(content, turn, 'handoff-seed', tag);
  } else if (role === 'user') {
    context.addUserMessage(content, turn, message.images as any);
  } else if (role === 'assistant') {
    context.addAssistantMessage(
      {
        content,
        toolCalls: message.toolCalls as any,
        reasoning: message.reasoning as any,
        thinkingBlocks: message.thinkingBlocks as any,
      },
      turn,
    );
  } else if (role === 'tool' && message.toolCallId) {
    context.addSerializedToolMessage(message.toolCallId, content, turn, message.images as any);
  } else {
    context.add({ role, content, turn, toolCallId: message.toolCallId, images: message.images, ...(tag ? { tag } : {}) } as any);
  }
}

export class HandoffSeedFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    injectHandoffSummary: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };
  readonly name = 'handoff-seed';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Injects a trimmed handoff transcript exactly once on the first CallStart when a runtime is booted from a handoff package.';

  private readonly handoff: HandoffSeedPayload;
  private injected = false;
  private logger?: FeatureInitContext['logger'];

  constructor(config: HandoffSeedFeatureConfig) {
    const rawSeedMessages = Array.isArray(config?.handoff?.seedMessages)
      ? config.handoff.seedMessages
      : [];
    this.handoff = {
      packageId: cleanValue(config?.handoff?.packageId),
      sourceSessionId: cleanValue(config?.handoff?.sourceSessionId),
      sourceSummary: cleanValue(config?.handoff?.sourceSummary),
      mode: cleanValue(config?.handoff?.mode),
      seedMessages: rawSeedMessages as any,
      importantFiles: Array.isArray(config?.handoff?.importantFiles)
        ? config.handoff.importantFiles.filter(f => typeof f === 'string')
        : [],
      importantSkills: Array.isArray(config?.handoff?.importantSkills)
        ? config.handoff.importantSkills.filter(s => typeof s === 'string')
        : [],
      fileRanges: typeof config?.handoff?.fileRanges === 'object' && config.handoff.fileRanges !== null
        ? config.handoff.fileRanges
        : {},
      featureContinuity: config?.handoff?.featureContinuity,
    };
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('Handoff seed feature initiated', {
      packageId: this.handoff.packageId || null,
      sourceSessionId: this.handoff.sourceSessionId || null,
      mode: this.handoff.mode || null,
      seedMessageCount: this.handoff.seedMessages?.length || 0,
      hasSourceSummary: Boolean(this.handoff.sourceSummary),
    });
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    this.logger?.info('Handoff seed feature destroyed', {
      injected: this.injected,
    });
  }

  captureState(): FeatureStateSnapshot {
    const snapshot: HandoffSeedSnapshot = {
      injected: this.injected,
    };
    return snapshot;
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as HandoffSeedSnapshot | null | undefined;
    this.injected = Boolean(state?.injected);
  }

  async injectHandoffSummary(ctx: CallStartContext): Promise<void> {
    if (this.injected || !ctx.isFirstCall) {
      return;
    }

    const fallbackTurn = typeof (ctx.agent as any)?._callIndex === 'number' ? (ctx.agent as any)._callIndex : 0;
    const seedMessages: HandoffSeedMessage[] = Array.isArray(this.handoff.seedMessages) ? this.handoff.seedMessages : [];

    let injectionTurn = fallbackTurn;

    if (seedMessages.length > 0) {
      seedMessages.forEach((message, index) => {
        const turn = typeof message?.turn === 'number' && Number.isFinite(message.turn)
          ? Number(message.turn)
          : (fallbackTurn + index);
        injectionTurn = Math.max(injectionTurn, turn + 1);
        injectSeedMessage(ctx.context, message, turn);
      });

      const agentRef = ctx.agent as any;
      if (typeof agentRef?._callIndex === 'number' && injectionTurn > agentRef._callIndex) {
        agentRef._callIndex = injectionTurn;
      }
    }

    if (this.handoff.sourceSummary && seedMessages.length === 0) {
      const isTrim = cleanValue(this.handoff.mode).startsWith('trim');
      const label = isTrim
        ? buildTrimContextLabel(this.handoff)
        : buildSummarySeedMessage(this.handoff);
      ctx.context.addSystemMessage(label, injectionTurn, this.name);
    }

    if (seedMessages.length === 0 && !this.handoff.sourceSummary) {
      return;
    }

    this.injected = true;
    this.logger?.info('Injected handoff seed', {
      packageId: this.handoff.packageId || null,
      sourceSessionId: this.handoff.sourceSessionId || null,
      seedMessageCount: seedMessages.length,
      turn: fallbackTurn,
    });

    this.injectImportantContext(ctx, injectionTurn);
  }

  private injectImportantContext(ctx: CallStartContext, baseTurn: number): void {
    const projectRoot = typeof (ctx.agent as any)?.projectRoot === 'string'
      ? (ctx.agent as any).projectRoot
      : process.cwd();

    let injectionTurn = baseTurn + 1;

    const fileBlocks = this.buildFileBlocks(projectRoot);
    for (const block of fileBlocks) {
      ctx.context.addSystemMessage(block, injectionTurn, this.name);
      injectionTurn += 1;
    }

    const skillBlocks = this.buildSkillBlocks(projectRoot);
    for (const block of skillBlocks) {
      ctx.context.addSystemMessage(block, injectionTurn, this.name);
      injectionTurn += 1;
    }
  }

  private resolveFilePath(filePath: string, projectRoot: string): string {
    if (existsSync(filePath)) return filePath;
    const resolved = resolve(projectRoot, filePath);
    if (existsSync(resolved)) return resolved;
    return filePath;
  }

  private buildFileBlocks(projectRoot: string): string[] {
    const files = this.handoff.importantFiles || [];
    if (files.length === 0) return [];

    const ranges = this.handoff.fileRanges || {};
    const blocks: string[] = [];
    const nameOnlyList: string[] = [];
    let totalChars = 0;

    for (const filePath of files) {
      const resolved = this.resolveFilePath(filePath, projectRoot);
      const content = this.tryReadFile(resolved);
      const range = ranges[filePath];
      const rangeLabel = range ? `（上次阅读行 ${range}）` : '';

      if (content === null) {
        nameOnlyList.push(`${filePath} ${rangeLabel}（文件未找到）`);
        continue;
      }
      const budget = Math.max(0, MAX_TOTAL_FILE_CHARS - totalChars);
      if (content.length <= budget && content.length <= MAX_FILE_CHARS) {
        blocks.push([
          `以下文件在此会话的前一轮中被标记为重要，内容已重新加载（行号为参考值，文件可能已变更）：`,
          '',
          `### ${filePath} ${rangeLabel}`,
          content,
        ].join('\n'));
        totalChars += content.length;
      } else {
        nameOnlyList.push(`${filePath} ${rangeLabel}`);
      }
    }

    if (nameOnlyList.length > 0) {
      const nameBlockLines = [
        '以下文件在此会话的前一轮中被标记为重要，但因超出显示上限或文件未找到仅保留路径（行号为参考值，文件可能已变更）：',
        '',
      ];
      for (const p of nameOnlyList) nameBlockLines.push(`- ${p}`);
      blocks.push(nameBlockLines.join('\n'));
    }

    return blocks;
  }

  private buildSkillBlocks(projectRoot: string): string[] {
    const skills = this.handoff.importantSkills || [];
    if (skills.length === 0) return [];

    const blocks: string[] = [];
    const nameOnlyList: string[] = [];
    let totalChars = 0;

    for (const skillName of skills) {
      const skillDir = join(projectRoot, '.agentdev', 'skills', skillName);
      const skillMdPath = join(skillDir, 'SKILL.md');
      const content = this.tryReadFile(skillMdPath);
      const basePath = normalize(skillDir);

      if (content === null) {
        nameOnlyList.push(`${skillName}（技能定义未找到，目录：${basePath}）`);
        continue;
      }

      const parsed = this.parseSkillMd(content);
      const header = [
        `**技能名称**：${parsed.name || skillName}`,
        parsed.description ? `**技能描述**：${parsed.description}` : '',
        `**技能的基础目录路径**：\`${basePath}\``,
        '',
        '---',
        '',
        parsed.body,
      ].filter(Boolean).join('\n');

      const budget = Math.max(0, MAX_TOTAL_SKILL_CHARS - totalChars);
      const truncated = header.length > MAX_SKILL_CHARS
        ? header.slice(0, MAX_SKILL_CHARS) + '\n（已截断）'
        : header;
      if (truncated.length <= budget) {
        blocks.push([
          '以下技能在此会话的前一轮中被标记为重要：',
          '',
          `### 技能: ${skillName}`,
          truncated,
        ].join('\n'));
        totalChars += truncated.length;
      } else {
        nameOnlyList.push(`${skillName}（目录：${basePath}）`);
      }
    }

    if (nameOnlyList.length > 0) {
      const nameBlockLines = [
        '以下技能在此会话的前一轮中被标记为重要，但因超出显示上限或定义未找到仅保留名称：',
        '',
      ];
      for (const s of nameOnlyList) nameBlockLines.push(`- ${s}`);
      blocks.push(nameBlockLines.join('\n'));
    }

    return blocks;
  }

  private parseSkillMd(content: string): { name: string; description: string; body: string } {
    const result = { name: '', description: '', body: content };
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return result;
    const yaml = frontmatterMatch[1];
    const nameMatch = yaml.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    if (nameMatch) result.name = nameMatch[1].trim();
    const descMatch = yaml.match(/^description:\s*["'](.+?)["']\s*$/m);
    if (descMatch) result.description = descMatch[1].trim();
    result.body = content.slice(frontmatterMatch[0].length).trim();
    return result;
  }

  private tryReadFile(filePath: string): string | null {
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf8');
      return content.length > MAX_FILE_CHARS
        ? content.slice(0, MAX_FILE_CHARS) + '\n（已截断）'
        : content;
    } catch {
      return null;
    }
  }
}
