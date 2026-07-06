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
  /** skills 目录，默认 baseDir/.agentdev/skills */
  dir?: string;
  /** 是否扫描 baseDir/.agentdev/skills，默认 true */
  scanAgentdevDir?: boolean;
  /** 是否扫描 baseDir/.claude/skills，默认 false */
  scanClaudeDir?: boolean;
  /** 额外 skills 目录列表，至多 5 个。相对路径以 baseDir 为基准 */
  extraDirs?: string[];
  /**
   * 相对路径的基准目录。
   * 所有相对路径（dir、scanAgentdevDir、scanClaudeDir、extraDirs）
   * 都以 baseDir 为基准解析。
   * 默认 process.cwd()。
   */
  baseDir?: string;
}
