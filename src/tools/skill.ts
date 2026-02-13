/**
 * Skill 工具
 * 用于动态加载和展示技能的详细文档
 */

import { readFile } from 'fs/promises';
import { dirname } from 'path';
import { createTool } from '../core/tool.js';
import type { Tool } from '../core/types.js';
import type { SkillMetadata } from '../skills/types.js';

export const invokeSkillTool: Tool = createTool({
  name: 'invoke_skill',
  description: '调用并展开指定技能的详细文档。技能提供专门的能力和领域知识。',
  parameters: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: '技能名称（如 xlsx, pdf 等）'
      }
    },
    required: ['skill']
  },
  render: { call: 'skill', result: 'file' },
  execute: async ({ skill }, context?: { _context?: { skills?: SkillMetadata[] } }) => {
    console.log(`[invoke_skill] ${skill}`);

    // 从 context 中获取 skills 列表
    const skills = context?._context?.skills || [];

    // 查找匹配的 skill
    const skillMetadata = skills.find(s => s.name === skill);

    if (!skillMetadata) {
      const availableSkills = skills.map(s => s.name).join(', ');
      return `错误：技能 "${skill}" 不存在。

可用技能列表：${availableSkills || '(无可用技能)'}

提示：请确保技能名称正确。`;
    }

    try {
      // 读取 SKILL.md 文件
      const content = await readFile(skillMetadata.path, 'utf-8');

      // 获取技能目录路径
      const basePath = dirname(skillMetadata.path);

      // 返回格式化的技能文档
      return `**技能名称**：${skillMetadata.name}

**技能描述**：${skillMetadata.description}

**技能的基础目录路径**：${basePath}

---

${content}`;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return `错误：无法读取技能文件 "${skill}"

详细信息：${errorMsg}

文件路径：${skillMetadata.path}`;
    }
  },
});
