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
import { dirname, join } from 'path';
import type {
  AgentFeature,
  FeatureInitContext,
  ContextInjector,
  ToolContextValue,
  PackageInfo,
} from '../../core/feature.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import type { ToolCall } from '../../core/types.js';
import { invokeSkillTool } from './tools.js';
import { discover } from '../../skills/loader.js';
import type { SkillMetadata, SkillsOptions } from '../../skills/types.js';
import { join as pathJoin, resolve, isAbsolute } from 'path';
import { cwd } from 'process';
import { DataSourceRegistry, createListRenderer } from '../../template/data-source.js';
import type { PlaceholderContext } from '../../template/types.js';
import { PlaceholderResolver } from '../../template/resolver.js';

// ESM 中获取 __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '发现本地 skills，并提供 invoke_skill 工具与技能数据源。';

  private skillsDir?: string;
  private skills: SkillMetadata[] = [];

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
      // 字符串路径
      this.skillsDir = isAbsolute(input) ? input : resolve(cwd(), input);
    } else if (input && typeof input === 'object') {
      // 配置对象
      this.skillsDir = input.dir;
    } else {
      // 默认路径
      this.skillsDir = pathJoin(cwd(), '.agentdev', 'skills');
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
   * 执行 Skills 发现并注册数据源
   */
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    if (this.skillsDir) {
      this.skills = await discover({ dir: this.skillsDir });
    }

    // 注册 skills 数据源到全局注册中心
    DataSourceRegistry.register({
      name: 'skills',
      getData: () => this.skills,
      renderItem: (skill: SkillMetadata, template: string, context: PlaceholderContext) => {
        // 将 skill 的属性合并到 context
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
