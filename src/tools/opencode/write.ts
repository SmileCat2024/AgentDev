/**
 * Write 工具 - 文件写入
 * 来自 opencode 项目的优秀实现
 */

import { createTool } from '../../core/tool.js';
import { writeFile, readFile, stat } from 'fs/promises';
import path from 'path';
import { createTwoFilesPatch } from 'diff';

/**
 * 文件写入工具
 */
export const writeTool = createTool({
  name: 'write',
  description: 'Write content to a file. Creates new files or overwrites existing files. THIS TOOL WILL OVERWRITE THE EXISTING FILE IF it exists. Only use this tool when explicitly requested to do so. Always prefer editing existing files using the edit tool when the file already exists.',
  render: 'write',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'The absolute path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      }
    },
    required: ['filePath', 'content']
  },
  execute: async ({ filePath, content }) => {
    console.log(`[write] ${filePath}`);

    const exists = await stat(filePath).then(() => true).catch(() => false);
    const contentOld = exists ? await readFile(filePath, 'utf-8') : '';

    // 生成 diff
    const diff = createTwoFilesPatch(filePath, filePath, contentOld, content);

    // 写入文件
    await writeFile(filePath, content, 'utf-8');

    return {
      filePath,
      existed: exists,
      diff,
      message: `File ${exists ? 'updated' : 'created'} successfully`
    };
  }
});
