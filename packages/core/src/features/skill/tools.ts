/**
 * Skill Feature 工具定义
 *
 * 提供 invoke_skill 工具，用于动态加载和展示技能的详细文档
 */

import { readFile } from 'fs/promises';
import { dirname, normalize } from 'path';
import type { Tool } from '../../core/types.js';
import type { SkillMetadata } from '../../skills/types.js';
import { splitFrontmatter } from '../../skills/loader.js';
import { createTool } from '../../core/tool.js';

/**
 * invoke_skill 工具
 *
 * 调用并展开指定技能的详细文档
 */
export const invokeSkillTool: Tool = createTool({
  name: 'invoke_skill',
  description: '调用并展开指定技能的详细文档。技能提供专门的能力和领域知识。',
  parallelizable: true,
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
  render: { call: 'skill', result: 'skill' },
  execute: async (args, context) => {
    const { skill } = args as { skill: string };
    console.log(`[invoke_skill] ${skill}`);

    // 从 context 中获取 skills 列表
    const ctx = context?._context as { skills?: SkillMetadata[] } | undefined;
    const skills = ctx?.skills || [];

    // 查找匹配的 skill
    const skillMetadata = skills.find(s => s.name === skill);

    if (!skillMetadata) {
      // 只列出模型可主动调用的技能：被禁用技能出现在这里会诱导模型反复重试
      const availableSkills = skills.filter(s => !s.disableModelInvocation).map(s => s.name).join(', ');
      return `错误：技能 "${skill}" 不存在。

可用技能列表：${availableSkills || '(无可用技能)'}

提示：请确保技能名称正确。`;
    }

    // disable-model-invocation：模型主动调用被禁用，仅保留用户/编排经
    // capability 激活的通道（slash 命令 / feature invoke）。此处是权威
    // 闸门，模型可见列表的过滤只是展示层
    if (skillMetadata.disableModelInvocation) {
      return `错误：技能 "${skill}" 已禁用模型主动调用（SKILL.md 声明 \`disable-model-invocation: true\`），不能经 invoke_skill 工具激活。

该技能仅可由用户在命令面板中主动选择，或由宿主编排显式激活。若当前任务确需该技能，请向用户说明并等待其激活，不要重试调用。`;
    }

    try {
      // frontmatter 原样保留但包进 yaml 围栏代码块，避免 markdown 渲染异常
      const raw = await readFile(skillMetadata.path, 'utf-8');
      const { frontmatter, body } = splitFrontmatter(raw);
      const content = [
        frontmatter ? ['```yaml', frontmatter, '```', ''].join('\n') : '',
        body,
      ].filter(Boolean).join('\n');

      // 获取技能目录路径，并规范化路径格式
      const basePath = normalize(dirname(skillMetadata.path));

      // 返回格式化的技能文档
      // 使用行内代码块包裹路径，避免 markdown 转义
      return `**技能名称**：${skillMetadata.name}

**技能描述**：${skillMetadata.description}

**技能的基础目录路径**：\`${basePath}\`

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
