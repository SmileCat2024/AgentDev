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

import type {
  AgentFeature,
  FeatureInitContext,
  ContextInjector,
  ToolContextValue,
} from '../core/feature.js';
import type { Tool } from '../core/types.js';
import type { ToolCall } from '../core/types.js';
import { invokeSkillTool } from '../tools/system/skill.js';
import { discover } from '../skills/loader.js';
import type { SkillMetadata, SkillsOptions } from '../skills/types.js';
import { join, resolve, isAbsolute } from 'path';
import { cwd } from 'process';

/**
 * Skill Feature 配置类型
 */
export interface SkillFeatureConfig extends SkillsOptions {
  /** Skills 目录路径 */
  dir?: string;
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
  readonly dependencies: string[] = [];

  private skillsDir?: string;
  private skills: SkillMetadata[] = [];

  constructor(input?: SkillFeatureInput) {
    if (typeof input === 'string') {
      // 字符串路径
      this.skillsDir = isAbsolute(input) ? input : resolve(cwd(), input);
    } else if (input && typeof input === 'object') {
      // 配置对象
      this.skillsDir = input.dir;
    } else {
      // 默认路径
      this.skillsDir = join(cwd(), '.agentdev', 'skills');
    }
  }

  /**
   * 获取同步工具（invoke_skill）
   */
  getTools(): Tool[] {
    return [invokeSkillTool];
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
   * 执行 Skills 发现
   */
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    if (this.skillsDir) {
      this.skills = await discover({ dir: this.skillsDir });
    }
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
