/**
 * Agent Skills 类型定义
 */

/**
 * Skill 元数据
 */
export interface SkillMetadata {
  /** Skill 名称 */
  name: string;
  /** Skill 描述 */
  description: string;
  /** SKILL.md 完整路径 */
  path: string;
}

/**
 * Skills 加载器配置
 */
export interface SkillsOptions {
  /** skills 目录，默认 cwd/.agentdev/skills */
  dir?: string;
}
