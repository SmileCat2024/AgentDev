/**
 * Safe Trash 工具定义
 *
 * 提供安全删除、列表和恢复工具，使用原生 TypeScript 实现
 */

import { join } from 'path';
import { cwd } from 'process';
import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import { safeRm, listTrashed, restore } from './lib/index.js';

// 默认垃圾目录
const DEFAULT_TRASH_DIR = join(cwd(), '.trash');

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * safe_trash_delete 工具
 *
 * 安全删除文件或目录，将它们移动到垃圾目录而非永久删除。
 * 删除的文件可以被 safe_trash_list 查看和 safe_trash_restore 恢复。
 */
export const safeTrashDeleteTool: Tool = createTool({
  name: 'safe_trash_delete',
  description: `安全删除文件或目录，移动到垃圾目录而非永久删除。

此工具将文件移动到垃圾目录（类似回收站），文件可以稍后恢复。支持删除单个文件、多个文件或整个目录树。

**重要注意事项：**
⚠️ 路径包含空格时必须使用引号包裹！例如: {"paths": ["file with spaces.txt"]}
⚠️ 系统文件（如 C:\\Windows、C:\\Program Files）受保护，无法删除
⚠️ 恢复时如目标位置已存在同名文件，需指定 overwrite=true

**用法示例：**
- 删除单个文件: {"paths": ["file.txt"]}
- 删除空格文件名（必须用引号）: {"paths": ["my document.txt"]}
- 删除多个文件: {"paths": ["file1.txt", "file2.txt"]}
- 删除目录: {"paths": ["./my-folder"]}
- 删除绝对路径: {"paths": ["C:\\\\Users\\\\username\\\\Desktop\\\\temp.txt"]}
- 混合路径: {"paths": ["file.txt", "./data/", "C:\\\\temp\\\\test.txt"]}

**最佳实践：**
1. 为所有路径使用引号包裹，避免空格解析问题
2. 删除前先用 safe_trash_list 确认垃圾目录状态
3. 重要文件删除后应立即验证 moved_count`,

  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: `要删除的文件或目录路径列表。

⚠️ **关键规则：包含空格的路径必须用引号包裹！**

**支持格式：**
- 相对路径: "./file.txt", "../data/file.txt"
- 绝对路径: "C:\\\\Users\\\\username\\\\Desktop\\\\file.txt"
- 目录路径: "./my-folder", "C:\\\\path\\\\to\\\\directory"
- 包含空格: "file with spaces.txt"（引号必须）

**正确示例：**
✅ ["file.txt"]
✅ ["my document.txt"] - 空格文件名
✅ ["file.txt", "my document.txt", "data folder"]
✅ ["C:\\\\Users\\\\name\\\\My Files\\\\doc.pdf"]

**错误示例：**
❌ 单个参数传递多个文件（必须使用数组）
❌ 路径中的空格未用引号包裹会导致解析错误

**目录删除：**
- 删除目录会递归删除其下所有文件和子目录
- 目录结构在垃圾目录中完整保留，可完整恢复`,
      },
      trashDir: {
        type: 'string',
        description: `垃圾目录路径（可选）。

指定用于存放已删除文件的目录。如果不指定，默认使用项目根目录下的 .trash 文件夹。

**目录结构：**
- trash_dir/
  ├── info/         # 存放 .trashinfo 元数据文件
  └── files/        # 存放实际被删除的文件

**示例：**
- 默认（项目根目录）: 不指定此参数
- 自定义目录: {"trashDir": "D:\\\\MyTrash"}
- 相对路径: {"trashDir": "./.my-trash"}`
      },
    },
    required: ['paths'],
  },
  render: { call: 'trash-delete', result: 'trash-delete' },
  execute: async ({ paths, trashDir }) => {
    const trashDirPath = trashDir || DEFAULT_TRASH_DIR;
    console.log(`[safe_trash_delete] Moving ${paths.length} item(s) to ${trashDirPath}`);

    try {
      const result = safeRm(
        null,
        paths.join(' '),
        trashDirPath,
        null,
        0
      );

      return {
        success: result.success,
        moved_count: result.movedCount,
        moved: result.moved,
        failed: result.failed,
      };
    } catch (error) {
      throw new Error(`Safe delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

/**
 * safe_trash_list 工具
 *
 * 列出垃圾目录中所有已删除的文件，显示它们的原始路径、删除日期和文件大小。
 */
export const safeTrashListTool: Tool = createTool({
  name: 'safe_trash_list',
  description: `列出垃圾目录中的所有可恢复文件。

显示所有已删除文件的列表，包括原始路径、删除时间、文件大小等信息。返回的文件按删除时间排序，每个文件都有一个索引号，可用于恢复操作。

**返回信息：**
- index: 文件索引（用于恢复操作）
- original_path: 原始文件路径
- deletion_date: 删除时间（ISO 8601 格式）
- size: 文件大小（字节）
- size_formatted: 格式化的文件大小（如 "1.5 MB"）

**用法示例：**
- 列出默认垃圾目录: {}
- 列出指定目录: {"trashDir": "D:\\\\MyTrash"}

**重要注意事项：**
⚠️ 文件恢复后索引会重新排序！每次恢复操作前请重新获取列表
⚠️ index 从 0 开始计数
⚠️ 文件按 deletion_date 升序排列（早删除的在前）

**最佳实践：**
1. 每次恢复操作前先调用 safe_trash_list 获取最新索引
2. 记录要恢复的文件 original_path，而不仅仅依赖 index
3. 对于连续恢复操作，建议使用路径模式而非索引`,

  parameters: {
    type: 'object',
    properties: {
      trashDir: {
        type: 'string',
        description: `垃圾目录路径（可选）。

指定要列出文件的垃圾目录。如果不指定，默认使用项目根目录下的 .trash 文件夹。

**示例：**
- 默认目录: 不指定此参数
- 自定义目录: {"trashDir": "D:\\\\MyTrash"}
- 相对路径: {"trashDir": "./.my-trash"}`
      },
    },
  },
  render: { call: 'trash-list', result: 'trash-list' },
  execute: async ({ trashDir }) => {
    const trashDirPath = trashDir || DEFAULT_TRASH_DIR;
    console.log(`[safe_trash_list] Listing ${trashDirPath}`);

    try {
      const result = listTrashed(trashDirPath, null);

      // 格式化文件大小
      const files = result.files.map((f) => ({
        ...f,
        size_formatted: formatSize(f.size || 0),
      }));

      return {
        success: result.success,
        total: result.total,
        files,
      };
    } catch (error) {
      throw new Error(`List trash failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

/**
 * safe_trash_restore 工具
 *
 * 从垃圾目录恢复文件到原始位置。
 */
export const safeTrashRestoreTool: Tool = createTool({
  name: 'safe_trash_restore',
  description: `从垃圾目录恢复文件到原位置。

将之前删除的文件从垃圾目录恢复到其原始位置。支持按索引恢复、按路径模式恢复（支持通配符）或按索引范围恢复。

**恢复方式示例：**
- 按索引: {"target": 0}
- 按路径模式: {"target": "*.txt"}
- 按索引范围: {"target": "0-5"}
- 多个索引: {"target": [0, 2, 5]}

**重要注意事项：**
⚠️ 每次恢复后索引会重新排序！连续操作时建议使用路径模式而非索引
⚠️ 使用 overwrite=true 会永久替换已存在文件，操作不可逆！
⚠️ 建议每次恢复前先调用 safe_trash_list 确认当前索引

**路径模式恢复（推荐用于连续操作）：**
- 精确匹配: {"target": "C:\\\\Users\\\\username\\\\Desktop\\\\file.txt"}
- 通配符: {"target": "*.txt"}
- 部分匹配: {"target": "*temp*"}

**按索引恢复（适用于一次性操作）：**
- 单个: {"target": 0}
- 多个: {"target": [0, 2, 5]}
- 范围: {"target": "0-5"} 或 {"target": "0,2,5-7"}

**覆盖控制：**
- 不覆盖（默认）: 目标位置存在同名文件时恢复失败
- 强制覆盖: {"overwrite": true} - ⚠️ 不可逆，请谨慎使用

**最佳实践：**
1. 连续恢复操作：每次恢复前重新调用 safe_trash_list
2. 推荐使用路径模式恢复，避免索引变化问题
3. 只在确认无需原文件时使用 overwrite=true`,

  parameters: {
    type: 'object',
    properties: {
      target: {
        oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } }],
        description: `要恢复的目标。支持多种格式：

**方式一：数字索引（单个）**
示例: {"target": 0}
说明: 恢复 safe_trash_list 返回的 index 为 0 的文件
⚠️ 注意: 文件恢复后索引会重新排序，连续操作不推荐

**方式二：数字索引（数组）**
示例: {"target": [0, 2, 5]}
说明: 一次性恢复多个指定索引的文件
⚠️ 注意: 建议先调用 safe_trash_list 确认最新索引

**方式三：路径模式字符串（推荐用于连续操作）**
示例: {"target": "*.txt"}, {"target": "C:\\\\Users\\\\*\\\\*.txt"}
说明: 使用通配符匹配文件路径，不受索引变化影响
支持的通配符:
  * : 匹配任意多个字符
  ? : 匹配单个字符
  [abc] : 匹配 a、b 或 c

**方式四：索引范围字符串**
示例: {"target": "0-5"}, {"target": "0,2,5-7"}
说明: 恢复指定范围的索引
⚠️ 注意: 连续恢复操作中索引可能变化

**路径模式示例（推荐使用）：**
✅ "*.txt" - 所有 .txt 文件
✅ "*temp*" - 包含 temp 的文件
✅ "C:\\\\Users\\\\username\\\\Desktop\\\\*" - 桌面所有文件
✅ "./data/*.log" - data 目录下所有 .log 文件
✅ "*document*" - 文件名包含 document 的文件

**索引范围示例：**
✅ "0" - 索引 0
✅ "0-3" - 索引 0、1、2、3
✅ "0,2,5" - 索引 0、2、5
✅ "0-2,5-7" - 索引 0-2 和 5-7`,
      },
      trashDir: {
        type: 'string',
        description: `垃圾目录路径（可选）。

指定要恢复文件的垃圾目录。如果不指定，默认使用项目根目录下的 .trash 文件夹。

**示例：**
- 默认目录: 不指定此参数
- 自定义目录: {"trashDir": "D:\\\\MyTrash"}`
      },
      overwrite: {
        type: 'boolean',
        description: `是否覆盖已存在的文件（默认 false）。

如果原始位置已存在同名文件：
- false（默认）: 恢复失败，文件保留在垃圾目录
- true: 强制覆盖，原文件被永久替换

**⚠️ 警告：overwrite=true 不可逆！**

**示例：**
- 不覆盖: 不指定此参数或 {"overwrite": false}
- 强制覆盖: {"overwrite": true}

**使用场景：**
- 默认行为: 保护已存在的新文件，避免意外丢失
- 强制覆盖: 确认要替换旧版本时使用`
      },
    },
    required: ['target'],
  },
  render: { call: 'trash-restore', result: 'trash-restore' },
  execute: async ({ target, trashDir, overwrite }) => {
    const trashDirPath = trashDir || DEFAULT_TRASH_DIR;
    console.log(`[safe_trash_restore] Restoring ${target} from ${trashDirPath}`);

    try {
      const result = restore(
        trashDirPath,
        target,
        null,
        overwrite || false,
        false,
        true
      );

      return {
        success: result.success,
        restored_count: result.restoredCount,
        restored: result.restored,
        failed: result.failed,
      };
    } catch (error) {
      throw new Error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
