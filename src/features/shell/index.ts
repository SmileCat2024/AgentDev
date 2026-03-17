/**
 * Shell Feature - Git Bash 命令执行工具 + 安全删除/恢复工具
 *
 * 通过 Git Bash 执行 Shell 命令，description 从内部配置加载
 * 提供安全删除、列表和恢复功能
 *
 * @example
 * ```typescript
 * import { ShellFeature } from './features/index.js';
 * const agent = new Agent({ ... }).use(new ShellFeature());
 * ```
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { cwd } from 'process';
import type { AgentFeature, FeatureInitContext, PackageInfo } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { createShellCommandTool } from './tools.js';
import { safeTrashDeleteTool, safeTrashListTool, safeTrashRestoreTool } from './tools-trash.js';

// ESM 中获取 __dirname
const __filename = fileURLToPath(import.meta.url);

/**
 * Shell Feature 实现
 */
export class ShellFeature implements AgentFeature {
  readonly name = 'shell';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '提供 bash 执行能力，以及安全删除、恢复和查看垃圾桶工具。';

  private bashDescription?: string;
  private _packageInfo: PackageInfo | null = null;

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   */
  getTemplateNames(): string[] {
    return [
      'bash',
      'trash-delete',
      'trash-list',
      'trash-restore',
    ];
  }

  /**
   * 获取同步工具（垃圾桶工具）
   */
  getTools(): Tool[] {
    return [
      safeTrashDeleteTool,
      safeTrashListTool,
      safeTrashRestoreTool,
    ];
  }

  /**
   * 获取异步工具（bash 工具，加载 description）
   */
  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    // 首次调用时加载 bash description
    if (!this.bashDescription) {
      // 优先尝试从外部文件加载
      try {
        const descriptionPath = resolve(cwd(), '.agentdev/prompts/tool-bash.md');
        this.bashDescription = await readFile(descriptionPath, 'utf-8');
      } catch {
        // 回退到内部默认描述
        this.bashDescription = '执行 Shell 命令（通过 Git Bash）';
      }
    }

    return [createShellCommandTool(this.bashDescription)];
  }

}
