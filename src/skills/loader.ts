/**
 * Agent Skills 加载器
 * 扫描目录，解析 SKILL.md 文件
 */

import { readdir, readFile } from 'fs/promises';
import { resolve, isAbsolute, join, normalize, dirname, isAbsolute as pathIsAbsolute } from 'path';
import { existsSync } from 'fs';
import type { SkillMetadata, SkillsOptions } from './types.js';
import { cwd as processCwd } from 'process';

/**
 * 解析 SKILL.md 文件的 YAML frontmatter
 * @param content 文件内容
 * @returns Skill 元数据或 null
 */
function parseSkillFrontmatter(content: string, path: string): SkillMetadata | null {
  // 检查是否有 YAML frontmatter（以 --- 开头）
  if (!content.trimStart().startsWith('---')) {
    return null;
  }

  // 提取 frontmatter 部分
  const frontmatterEnd = content.indexOf('---', 3);
  if (frontmatterEnd === -1) {
    return null;
  }

  const frontmatterStr = content.slice(3, frontmatterEnd).trim();

  // 简单解析 YAML（只需提取 name 和 description）
  const nameMatch = frontmatterStr.match(/^name:\s*(.+)$/m);
  const descriptionMatch = frontmatterStr.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !descriptionMatch) {
    return null;
  }

  const name = nameMatch[1].trim();
  const description = descriptionMatch[1].trim();

  // 移除可能的引号
  const cleanValue = (value: string): string => {
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  };

  return {
    name: cleanValue(name),
    description: cleanValue(description),
    path,
  };
}

/**
 * 扫描目录下的 SKILL.md 文件（仅一级结构）
 *
 * 标准结构：每个一级子目录代表一个 skill，其内部直接包含 SKILL.md。
 * 同时兼容 SKILL.md 直接放在 skills 根目录的情况。
 * 不做递归深入。
 */
async function collectSkillFiles(dir: string): Promise<string[]> {
  const skillFiles: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // SKILL.md 直接放在根目录的情况
      if (entry.isFile() && entry.name === 'SKILL.md') {
        skillFiles.push(normalize(fullPath));
        continue;
      }

      // 一级子目录（含指向目录的符号链接）：检查其直接子项是否包含 SKILL.md
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          const stats = await readFileStats(fullPath);
          isDir = stats.isDirectory();
        } catch {
          continue;
        }
      }

      if (isDir) {
        try {
          const subEntries = await readdir(fullPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isFile() && subEntry.name === 'SKILL.md') {
              skillFiles.push(normalize(join(fullPath, 'SKILL.md')));
              break; // 每个 skill 目录只取一个 SKILL.md
            }
          }
        } catch {
          // 容错：跳过无法访问的子目录
        }
      }
    }
  } catch {
    // 容错：跳过无法访问的目录
  }

  return skillFiles;
}

/**
 * 安全地读取文件状态（支持符号链接）
 */
async function readFileStats(path: string): Promise<{ isDirectory(): boolean }> {
  const { stat } = await import('fs/promises');
  return stat(path);
}

/**
 * 发现并加载指定目录下的所有 skills
 * @param options Skills 配置选项
 * @returns Skill 元数据列表
 */
export async function discover(options: SkillsOptions = {}): Promise<SkillMetadata[]> {
  const { dir, baseDir } = options;

  // 解析 skills 目录路径
  const skillsDir = resolveSkillsDir(dir, baseDir);

  // 检查目录是否存在
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: SkillMetadata[] = [];

  try {
    // 扫描一级目录结构（每个子目录一个 skill）
    const skillFiles = await collectSkillFiles(skillsDir);

    for (const fullPath of skillFiles) {
      try {
        const content = await readFile(fullPath, 'utf-8');
        const metadata = parseSkillFrontmatter(content, fullPath);

        if (metadata) {
          skills.push(metadata);
        }
      } catch {
        // 容错：跳过读取失败的文件
      }
    }
  } catch {
    // 容错：目录扫描失败时返回空数组
    return [];
  }

  return skills;
}

/**
 * 解析 skills 目录路径
 * @param dir 用户指定的目录路径
 * @param baseDir 相对路径基准目录，默认 process.cwd()
 * @returns 解析后的绝对路径
 */
function resolveSkillsDir(dir?: string, baseDir?: string): string {
  const resolvedBase = baseDir ?? process.cwd();

  // 如果用户指定了目录
  if (dir) {
    // 绝对路径直接使用
    if (isAbsolute(dir)) {
      return dir;
    }
    // 相对路径以 baseDir 为基准
    return resolve(resolvedBase, dir);
  }

  // 默认使用 baseDir/.agentdev/skills
  return resolve(resolvedBase, '.agentdev', 'skills');
}

/**
 * 对同名 skill 添加序号后缀：第一个保持原名，后续加 (1)、(2)...
 */
function deduplicateSkills(skills: SkillMetadata[]): SkillMetadata[] {
  const nameCount = new Map<string, number>();
  return skills.map(skill => {
    const count = nameCount.get(skill.name) || 0;
    nameCount.set(skill.name, count + 1);
    if (count === 0) return skill;
    return { ...skill, name: `${skill.name} (${count})` };
  });
}

/**
 * 多目录发现：按配置扫描 .agentdev/skills、.claude/skills 及额外目录，
 * 合并结果并对同名 skill 自动加后缀。
 */
export async function discoverMulti(options: SkillsOptions = {}): Promise<SkillMetadata[]> {
  const {
    dir,
    scanAgentdevDir = true,
    scanClaudeDir = false,
    extraDirs = [],
    baseDir,
  } = options;
  const resolvedBase = baseDir ?? processCwd();
  const directories: string[] = [];

  // Explicitly specified dir takes highest priority
  if (dir) {
    directories.push(isAbsolute(dir) ? dir : resolve(resolvedBase, dir));
  }

  if (scanAgentdevDir) {
    directories.push(resolve(resolvedBase, '.agentdev', 'skills'));
  }
  if (scanClaudeDir) {
    directories.push(resolve(resolvedBase, '.claude', 'skills'));
  }
  const limitedExtras = extraDirs.filter(Boolean).slice(0, 5);
  for (const d of limitedExtras) {
    directories.push(isAbsolute(d) ? d : resolve(resolvedBase, d));
  }

  // Deduplicate directories — on Windows the same physical path can appear
  // with different drive-letter casing (e.g. "D:\…" vs "d:\…").
  const isWin = process.platform === 'win32';
  const seen = new Set<string>();
  const uniqueDirs = directories.filter(d => {
    const key = isWin ? d.toLowerCase() : d;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const allSkills: SkillMetadata[] = [];
  for (const dir of uniqueDirs) {
    const skills = await discover({ dir });
    allSkills.push(...skills);
  }

  return deduplicateSkills(allSkills);
}
