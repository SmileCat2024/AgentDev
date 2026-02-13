/**
 * Agent Skills 加载器
 * 扫描目录，解析 SKILL.md 文件
 */

import { readdir, readFile } from 'fs/promises';
import { resolve, isAbsolute, join } from 'path';
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
    // 递归扫描目录
    const entries = await readdir(skillsDir, { withFileTypes: true, recursive: true });

    for (const entry of entries) {
      // 只处理名为 SKILL.md 的文件
      if (entry.isFile() && entry.name === 'SKILL.md') {
        // entry.path 在 recursive 模式下是文件的父目录，需要拼接文件名
        // 例如: entry.path = "xlsx", entry.name = "SKILL.md" -> "xlsx/SKILL.md"
        const relativePath = entry.path ? join(entry.path, entry.name) : entry.name;

        // 如果 relativePath 是绝对路径，直接使用；否则拼接 skillsDir
        const isAbsolutePath = relativePath.match(/^[A-Za-z]:\\/) || relativePath.startsWith('/');
        const fullPath = isAbsolutePath ? relativePath : join(skillsDir, relativePath);

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
    return resolve(cwd, dir);
  }

  // 默认使用 cwd/.agentdev/skills
  return resolve(cwd, '.agentdev', 'skills');
}
