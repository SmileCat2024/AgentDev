/**
 * Agent Skills 加载器
 * 扫描目录，解析 SKILL.md 文件
 */

import { readdir, readFile } from 'fs/promises';
import { resolve, isAbsolute, join, normalize, dirname, isAbsolute as pathIsAbsolute } from 'path';
import { existsSync } from 'fs';
import type { SkillMetadata, SkillsOptions } from './types.js';

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
 * 递归扫描目录并收集 SKILL.md 文件
 * 支持跟随符号链接目录
 */
async function collectSkillFiles(dir: string, skillsDir: string): Promise<string[]> {
  const skillFiles: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // 如果是 SKILL.md 文件，直接收集
      if (entry.isFile() && entry.name === 'SKILL.md') {
        skillFiles.push(normalize(fullPath));
      }
      // 如果是目录，递归扫描（包括符号链接目录）
      else if (entry.isDirectory() || entry.isSymbolicLink()) {
        // 对于符号链接，需要检查它是否指向一个目录
        let isLinkToDir = false;
        if (entry.isSymbolicLink()) {
          try {
            const stats = await readFileStats(fullPath);
            isLinkToDir = stats.isDirectory();
          } catch {
            // 符号链接目标不存在或无法访问，跳过
            continue;
          }
        }

        if (isLinkToDir || entry.isDirectory()) {
          const subFiles = await collectSkillFiles(fullPath, skillsDir);
          skillFiles.push(...subFiles);
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
  const { dir } = options;

  // 解析 skills 目录路径
  const skillsDir = resolveSkillsDir(dir);

  // 检查目录是否存在
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: SkillMetadata[] = [];

  try {
    // 手动递归扫描目录，支持符号链接
    const skillFiles = await collectSkillFiles(skillsDir, skillsDir);

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
 * @returns 解析后的绝对路径
 */
function resolveSkillsDir(dir?: string): string {
  const cwd = process.cwd();

  // 如果用户指定了目录
  if (dir) {
    // 绝对路径直接使用
    if (isAbsolute(dir)) {
      return dir;
    }
    // 相对路径以 cwd 为基准
    const resolved = resolve(cwd, dir);
    // 确保 Windows 路径使用正确的分隔符
    return resolved;
  }

  // 默认使用 cwd/.agentdev/skills
  return resolve(cwd, '.agentdev', 'skills');
}
