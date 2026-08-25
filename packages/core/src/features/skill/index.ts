/**
 * Skill Feature - Skills 发现和 invoke_skill 工具
 *
 * 将 Skills 集成从 Agent 核心中解耦，实现可外挂功能
 *
 * @example
 * ```typescript
 * // 使用默认路径 .agentdev/skills
 * agent.use(new SkillFeature());
 *
 * // 使用自定义路径
 * agent.use(new SkillFeature('./custom/skills'));
 * agent.use(new SkillFeature({ dir: './custom/skills' }));
 * ```
 */

import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { normalize, dirname } from 'path';
import type {
  AgentFeature,
  FeatureInitContext,
  FeatureManifestDefinition,
  ContextInjector,
  ToolContextValue,
  PackageInfo,
} from '../../core/feature.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import type { CapabilityDefinition } from '../../core/capability.js';
import type { Logger } from '../../core/logging.js';
import { invokeSkillTool } from './tools.js';
import { discoverMulti } from '../../skills/loader.js';
import type { SkillMetadata, SkillsOptions } from '../../skills/types.js';
import type { PlaceholderContext } from '../../template/types.js';
import { PlaceholderResolver } from '../../template/resolver.js';

// ESM 中获取 __filename
const __filename = fileURLToPath(import.meta.url);

/**
 * 技能文档注入时统一降级标题层级（+3，封顶 h6）。
 * SKILL.md 惯例以 `#` 开篇，聊天界面按 h1 渲染会撑爆消息块；
 * 注入场景只需要最小标题 + 正文的密度，保留相对层级即可。
 */
function demoteHeadings(md: string): string {
  return md.replace(/^(#{1,6})(\s)/gm, (_m, hashes: string, sep: string) => {
    return `${'#'.repeat(Math.min(hashes.length + 3, 6))}${sep}`;
  });
}

/**
 * Skill Feature 配置类型
 */
export interface SkillFeatureConfig extends SkillsOptions {
  /** Skills 目录路径 */
  dir?: string;
  /** 是否扫描 .agentdev/skills，默认 true */
  scanAgentdevDir?: boolean;
  /** 是否扫描 .claude/skills，默认 false */
  scanClaudeDir?: boolean;
  /** 额外 skills 目录列表 */
  extraDirs?: string[];
  /** 相对路径基准目录，默认 process.cwd() */
  baseDir?: string;
}

/**
 * Skill Feature 输入类型
 */
export type SkillFeatureInput = SkillFeatureConfig | string | undefined;

/**
 * Skill Feature 实现
 */
export class SkillFeature implements AgentFeature {
  readonly name = 'skill';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '发现本地 skills，并提供 invoke_skill 工具与技能数据源。';

  private skillsDir?: string;
  private skills: SkillMetadata[] = [];
  private featureSkills: SkillMetadata[] = [];
  private scanAgentdevDir: boolean = true;
  private scanClaudeDir: boolean = false;
  private extraDirs: string[] = [];

  private logger?: Logger;

  /**
   * 缓存包信息
   */
  private _packageInfo: PackageInfo | null = null;

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   */
  getTemplateNames(): string[] {
    return ['skill'];
  }

  constructor(input?: SkillFeatureInput) {
    if (typeof input === 'string') {
      // Relative paths must remain unresolved until onInitiate, when the
      // session-scoped workspaceDir is available. Resolving here would bind a
      // shared runtime to its host process cwd instead.
      this.skillsDir = input;
    } else if (input && typeof input === 'object') {
      this.skillsDir = input.dir;
      this.scanAgentdevDir = input.scanAgentdevDir ?? true;
      this.scanClaudeDir = input.scanClaudeDir ?? false;
      this.extraDirs = Array.isArray(input.extraDirs) ? input.extraDirs.filter(Boolean) : [];
    } else {
      this.skillsDir = undefined;
    }
  }

  /**
   * 获取同步工具（invoke_skill）
   */
  getTools(): Tool[] {
    return [invokeSkillTool];
  }

  /**
   * 将已发现的 skills 动态注册为 capability 命令。
   *
   * 每个 skill 一条 `skill.<name>` 命令，双入口：用户经 slash 菜单激活，
   * 或其他 feature / 编排经 registry invoke 激活。激活凭证是随消息流动
   * 的结构化通知（user-turn 的 capabilityActivations 元数据，见
   * onCapabilityActivations）——invoke 只做选中校验与审计，不承载激活态：
   * 排队投递、线程交接、后继会话等"消息晚到 / 换进程"场景下，激活通知
   * 始终作为消息本体的元数据到达，不依赖进程内暂存或输入文本解析。
   */
  getCapabilities(): CapabilityDefinition[] {
    return this.skills.map((skill) => ({
      name: skill.name,
      kind: 'prompt' as const,
      title: `技能：${skill.name}`,
      description: skill.description,
      entryPoints: ['slash', 'feature'],
      execute: () => {
        if (!this.skills.some((s) => s.name === skill.name)) {
          return Promise.reject(new Error(`skill "${skill.name}" no longer exists`));
        }
        return Promise.resolve({
          activated: skill.name,
          note: `技能「${skill.name}」已激活，随下一条消息自动加载`,
        });
      },
    }));
  }

  /**
   * 消费随消息到达的技能激活通知，注入对应技能文档。
   *
   * Agent 在两个消息落地点派发（新 call 的 onCall 第三参 / busy 排队
   * 消息的步边界注入），refs 只含本 feature 前缀的条目。文档以 system
   * 位置注入（与 flow 提示词 / force-continuation 的既有形态一致）。
   * 注入失败（文件缺失等）记日志，不阻断本轮 call。
   */
  async onCapabilityActivations(refs: string[], ctx: { context: import('../../core/context.js').Context }): Promise<void> {
    const names = new Set<string>();
    for (const ref of refs) {
      if (typeof ref !== 'string') continue;
      if (!ref.startsWith('skill.')) continue;
      names.add(ref.slice('skill.'.length));
    }
    if (names.size === 0) return;

    for (const skillName of names) {
      const skill = this.skills.find((s) => s.name === skillName);
      if (!skill) {
        this.logger?.warn(`Activated skill "${skillName}" no longer exists, skipped injection`);
        continue;
      }

      try {
        const content = await readFile(skill.path, 'utf-8');
        const basePath = normalize(dirname(skill.path)).replace(/\\/g, '/');
        ctx.context.add({
          role: 'system',
          content: [
            `[技能激活：${skill.name}]`,
            `技能基础目录：\`${basePath}\``,
            '---',
            demoteHeadings(content),
          ].join('\n'),
        });
        this.logger?.info(`Skill "${skill.name}" injected via turn activation notification`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger?.warn(`Failed to inject activated skill "${skillName}": ${msg}`);
      }
    }
  }

  /**
   * 向 Flow 暴露 Skills 相关变量
   */
  getFlowVariables() {
    return [
      {
        key: 'skillSummaryItems',
        type: 'string',
        title: '技能列表数组',
        description: '可用技能的“名称：介绍”数组，适合做变量遍历或直接插入。',
        resolver: () => this.skills.map(skill => `${skill.name}：${skill.description}`),
      },
      {
        key: 'skillSummaryText',
        type: 'string',
        title: '技能列表文本',
        description: '可用技能的多行文本版本，每行一条“- 名称：介绍”。',
        resolver: () => this.skills.map(skill => `- ${skill.name}：${skill.description}`).join('\n'),
      },
    ];
  }

  /**
   * 向 Flow 暴露可直接复用的节点 Prompt 模板
   */
  getFlowNodeTemplates() {
    return [
      {
        id: 'skill-availability-prompt',
        name: '技能列表提示',
        description: '向 Agent 注入当前可用技能列表，并提示通过 invoke_skill 激活具体技能。',
        prompt: '你有以下技能可用，可使用invoke_skill工具激活：\n{{skillSummaryText}}',
        tools: { enable: ['invoke_skill'] },
      },
    ];
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1 as const,
      settings: {
        properties: {
          scanAgentdevDir: {
            type: 'boolean',
            title: '扫描 .agentdev/skills',
            description: '是否从工作目录的 .agentdev/skills/ 加载技能文件。',
            default: true,
          },
          scanClaudeDir: {
            type: 'boolean',
            title: '扫描 .claude/skills',
            description: '是否从工作目录的 .claude/skills/ 加载技能文件。',
            default: false,
          },
          extraDirs: {
            type: 'directory',
            title: '额外技能目录',
            description: '额外加载技能文件的目录列表（至多 5 个）。相对路径以工作目录为基准，绝对路径直接使用。同名技能会自动加后缀区分。',
            default: [],
            maxItems: 5,
          },
        },
      },
    };
  }

  /**
   * 声明上下文注入器
   * 为 invoke_skill 工具注入 _context.skills
   */
  getContextInjectors(): Map<string | RegExp, ContextInjector> {
    return new Map<string | RegExp, ContextInjector>([
      ['invoke_skill', (): ToolContextValue => ({ _context: { skills: this.skills } })],
    ]);
  }

  /**
   * 初始化钩子
   * 执行 Skills 发现并注册数据源
   *
   * featureConfig（运行时配置）覆盖构造函数的默认值。
   * 路径解析以 agent 的 workspaceDir 为基准。
   */
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    // 从 featureConfig 读取运行时配置，覆盖构造函数默认值
    const fc = ctx.featureConfig;
    let scanAgentdevDir = this.scanAgentdevDir;
    let scanClaudeDir = this.scanClaudeDir;
    let extraDirs = this.extraDirs;

    if (fc && typeof fc === 'object') {
      const c = fc as Record<string, unknown>;
      if (typeof c.scanAgentdevDir === 'boolean') scanAgentdevDir = c.scanAgentdevDir;
      if (typeof c.scanClaudeDir === 'boolean') scanClaudeDir = c.scanClaudeDir;
      if (Array.isArray(c.extraDirs)) {
        extraDirs = c.extraDirs.filter((d): d is string => typeof d === 'string' && d.trim() !== '');
      }
    }

    // 使用 agent 的 workspaceDir 作为路径基准
    const baseDir = ctx.config?.workspaceDir;

    // 使用多目录发现：.agentdev/skills + .claude/skills + 额外目录
    this.skills = await discoverMulti({
      dir: this.skillsDir,
      scanAgentdevDir,
      scanClaudeDir,
      extraDirs,
      baseDir,
    });

    // 合并 Feature 自带 skills，用户 skills 优先（同名覆盖）
    if (this.featureSkills.length > 0) {
      const userSkillNames = new Set(this.skills.map(s => s.name));
      for (const s of this.featureSkills) {
        if (!userSkillNames.has(s.name)) {
          this.skills.push(s);
        }
      }
    }

    // 注册 skills 数据源到 Agent 级注册表（per-Agent 实例，非进程全局）
    ctx.dataSourceRegistry.register({
      name: 'skills',
      getData: () => this.skills,
      renderItem: (skill: SkillMetadata, template: string, context: PlaceholderContext) => {
        const skillContext: PlaceholderContext = {
          ...context,
          name: skill.name,
          description: skill.description,
          this: skill,
        };
        return PlaceholderResolver.resolve(template, skillContext);
      },
    });
  }

  /**
   * 注入来自其他 Feature 的 skills
   * 由 Agent 在 onInitiate 之前调用
   */
  addFeatureSkills(skills: SkillMetadata[]): void {
    this.featureSkills = skills;
  }

  /**
   * 获取已加载的 Skills
   */
  getSkills(): SkillMetadata[] {
    return this.skills;
  }

  /**
   * 设置 Skills 目录
   */
  setSkillsDir(dir: string): void {
    this.skillsDir = dir;
  }
}
