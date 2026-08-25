/**
 * Agent Skills 加载器
 * 扫描目录，解析 SKILL.md 文件
 */

import { readdir, readFile } from 'fs/promises';
import { resolve, isAbsolute, join, normalize, dirname, isAbsolute as pathIsAbsolute } from 'path';
import { existsSync } from 'fs';
import type { SkillMetadata, SkillsOptions } from './types.js';
import { cwd as processCwd } from 'process';
import yaml from 'js-yaml';

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

  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(frontmatterStr) as Record<string, unknown>;
  } catch (err) {
    // YAML 解析失败（常见于多行 description 中含 "key: value" 模式，
    // 如 "Use when:" 被 YAML 误解为映射条目）。
    // 尝试 fallback：逐行提取 name 和 description。
    const fallback = parseFrontmatterFallback(frontmatterStr, path);
    if (fallback) {
      console.warn(
        `[skills/loader] YAML frontmatter parse failed for ${path}, used fallback parser. ` +
        `Consider quoting multi-line descriptions or using block scalar (|).` +
        (err instanceof Error ? ` Error: ${err.message.split('\n')[0]}` : '')
      );
      return fallback;
    }
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const name = typeof parsed.name === 'string' ? parsed.name.trim() : null;
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : null;

  if (!name || !description) return null;

  return { name, description, path };
}

/**
 * Fallback frontmatter 解析器
 *
 * 当 js-yaml 因格式问题（如多行 description 中的冒号）解析失败时，
 * 使用逐行匹配提取 name 和 description 字段。
 * description 的值会被拼接为单行文本（空格分隔续行）。
 */
function parseFrontmatterFallback(frontmatterStr: string, path: string): SkillMetadata | null {
  const lines = frontmatterStr.split('\n');
  let name: string | null = null;
  let description: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch && !name) {
      name = nameMatch[1].trim();
      continue;
    }
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch && !description) {
      // 收集 description 值和所有缩进的续行
      const descParts: string[] = [];
      if (descMatch[1].trim()) descParts.push(descMatch[1].trim());
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        // 续行以空格开头（缩进）；顶格行是新 key，停止收集
        if (/^\s/.test(nextLine)) {
          descParts.push(nextLine.trim());
        } else {
          break;
        }
      }
      description = descParts.join(' ').trim();
    }
  }

  if (!name || !description) return null;
  return { name, description, path };
}

/**
 * 拆分 SKILL.md 开头的 YAML frontmatter，返回 [frontmatter 原文, 正文]。
 *
 * frontmatter 含 name/description 之外的用户元数据，注入时必须原样保留；
 * 但若直接拼进 markdown，开头的 `---` 会被渲染成水平线、紧随的 YAML 文本
 * 被 setext 语法解析成大标题。调用方应将 frontmatter 包进 ```yaml 围栏
 * 代码块后再拼接，使其渲染为代码块。
 */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return { frontmatter: '', body: content };

  const frontmatterEnd = trimmed.indexOf('\n---', 3);
  if (frontmatterEnd === -1) return { frontmatter: '', body: content };

  const rest = trimmed.slice(trimmed.indexOf('\n', frontmatterEnd + 1) + 1);
  return {
    frontmatter: trimmed.slice(0, frontmatterEnd + 4).trim(),
    body: rest.trimStart(),
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
