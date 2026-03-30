/**
 * Shell Feature - 独立 npm 包
 *
 * 提供 Bash 执行和安全删除/恢复功能
 *
 * @example
 * ```typescript
 * import { ShellFeature } from '@agentdev/shell-feature';
 * import { BasicAgent } from 'agentdev';
 *
 * const agent = new BasicAgent().use(new ShellFeature());
 * ```
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import type { AgentFeature, FeatureInitContext, PackageInfo } from 'agentdev';
import type { Tool } from 'agentdev';
import { getPackageInfoFromSource } from 'agentdev';
import { createShellCommandTool } from './tools.js';
import { createSafeTrashDeleteTool, createSafeTrashListTool, createSafeTrashRestoreTool } from './tools-trash.js';

const __filename = fileURLToPath(import.meta.url);

export interface ShellFeatureConfig {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
}

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
  private readonly workspaceDir: string;
  private readonly workdir: string;
  private readonly resourceRoot: string;

  constructor(config: ShellFeatureConfig = {}) {
    this.workspaceDir = config.workspaceDir || process.cwd();
    this.workdir = config.workdir || this.workspaceDir;
    this.resourceRoot = config.resourceRoot || process.cwd();
  }

  /**
   * 获取同步工具（垃圾桶工具）
   */
  getTools(): Tool[] {
    return [
      createSafeTrashDeleteTool(this.workdir),
      createSafeTrashListTool(this.workdir),
      createSafeTrashRestoreTool(this.workdir),
    ];
  }

  /**
   * 获取异步工具（bash 工具，加载 description）
   */
  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    if (!this.bashDescription) {
      try {
        const descriptionPath = resolve(this.resourceRoot, '.agentdev/prompts/tool-bash.md');
        this.bashDescription = await readFile(descriptionPath, 'utf-8');
      } catch {
        this.bashDescription = '执行 Shell 命令（通过 Git Bash）';
      }
    }
    return [createShellCommandTool(this.bashDescription, {
      workspaceDir: this.workspaceDir,
      workdir: this.workdir,
      resourceRoot: this.resourceRoot,
    })];
  }

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
      'safe_trash_delete',
      'safe_trash_list',
      'safe_trash_restore',
      'trash-delete',
      'trash-list',
      'trash-restore',
    ];
  }
}

// 导出工具创建函数（供高级用户使用）
export { createShellCommandTool } from './tools.js';
export {
  safeTrashDeleteTool,
  safeTrashListTool,
  safeTrashRestoreTool,
  createSafeTrashDeleteTool,
  createSafeTrashListTool,
  createSafeTrashRestoreTool,
} from './tools-trash.js';

// 导出库函数（供高级用户使用）
export { safeRm, listTrashed, restore } from './lib/index.js';
