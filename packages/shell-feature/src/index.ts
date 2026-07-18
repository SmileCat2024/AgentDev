/**
 * Shell Feature - 独立 npm 包
 *
 * 支持 Bash（Windows: Git Bash / Linux/macOS: 原生 bash）和 PowerShell 两种 Shell 环境。
 * 根据用户配置和运行时探测结果，条件注册 Bash 和/或 PowerShell 工具。
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
import type { AgentFeature, FeatureInitContext, FeatureManifestDefinition, PackageInfo } from 'agentdev';
import type { Tool } from 'agentdev';
import { getPackageInfoFromSource } from 'agentdev';
import { createShellCommandTool, findGitBashPath } from './tools.js';
import { createPowerShellTool, findPowerShellPath } from './powershell.js';
import { createSafeTrashDeleteTool, createSafeTrashListTool, createSafeTrashRestoreTool } from './tools-trash.js';

const __filename = fileURLToPath(import.meta.url);

export interface ShellFeatureConfig {
  workspaceDir?: string;
  workdir?: string;
  resourceRoot?: string;
}

interface ResolvedShellConfig {
  bashEnabled: boolean;
  bashPath?: string;
  powershellEnabled: boolean;
  powershellPath?: string;
}

/**
 * Shell Feature 实现
 */
export class ShellFeature implements AgentFeature {
  readonly name = 'shell';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '提供 Bash/PowerShell 命令执行能力，以及安全删除、恢复和查看垃圾桶工具。';

  private bashDescription?: string;
  private powershellDescription?: string;
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

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1 as const,
      settings: {
        properties: {
          bashEnabled: {
            type: 'boolean',
            title: '启用 Bash',
            description: '启用后，Agent 将获得 Bash 工具。Windows 需要 Git for Windows；Linux/macOS 使用系统自带 Shell。',
            default: true,
          },
          bashPath: {
            type: 'file',
            title: 'Bash 路径',
            description: 'Bash 可执行文件路径。留空时自动检测。',
            placeholder: '自动检测',
          },
          powershellEnabled: {
            type: 'boolean',
            title: '启用 PowerShell',
            description: '启用后，Agent 将获得 PowerShell 工具。Windows 自带 PowerShell 5.1；Linux/macOS 需安装 PowerShell Core (pwsh)。',
            default: true,
          },
          powershellPath: {
            type: 'file',
            title: 'PowerShell 路径',
            description: 'PowerShell 可执行文件路径。留空时自动检测。',
            placeholder: '自动检测',
          },
        },
      },
    };
  }

  private resolveShellConfig(featureConfig: unknown): ResolvedShellConfig {
    if (!featureConfig || typeof featureConfig !== 'object') {
      return { bashEnabled: true, powershellEnabled: true };
    }
    const c = featureConfig as Record<string, unknown>;
    return {
      bashEnabled: c.bashEnabled !== false,
      bashPath: typeof c.bashPath === 'string' && c.bashPath.trim() ? c.bashPath.trim() : undefined,
      powershellEnabled: c.powershellEnabled !== false,
      powershellPath: typeof c.powershellPath === 'string' && c.powershellPath.trim() ? c.powershellPath.trim() : undefined,
    };
  }

  /**
   * 获取异步工具（bash/powershell 工具，条件注册）
   */
  async getAsyncTools(ctx: FeatureInitContext): Promise<Tool[]> {
    const config = this.resolveShellConfig(ctx.featureConfig);
    const tools: Tool[] = [];

    // ── Bash 工具 ──
    if (config.bashEnabled) {
      const bashPath = findGitBashPath(config.bashPath);
      if (bashPath) {
        if (!this.bashDescription) {
          try {
            const descriptionPath = resolve(this.resourceRoot, '.agentdev/prompts/tool-bash.md');
            this.bashDescription = await readFile(descriptionPath, 'utf-8');
          } catch {
            this.bashDescription = '执行 Shell 命令';
          }
        }
        tools.push(createShellCommandTool(this.bashDescription, {
          workspaceDir: this.workspaceDir,
          workdir: this.workdir,
          resourceRoot: this.resourceRoot,
          bashPath,
        }));
      } else {
        console.warn('[shell] Bash is enabled but was not found on this system. Skipping Bash tool.');
      }
    }

    // ── PowerShell 工具 ──
    if (config.powershellEnabled) {
      const psPath = findPowerShellPath(config.powershellPath);
      if (psPath) {
        if (!this.powershellDescription) {
          try {
            const descriptionPath = resolve(this.resourceRoot, '.agentdev/prompts/tool-powershell.md');
            this.powershellDescription = await readFile(descriptionPath, 'utf-8');
          } catch {
            this.powershellDescription = '执行 PowerShell 命令';
          }
        }
        tools.push(createPowerShellTool(this.powershellDescription, {
          workspaceDir: this.workspaceDir,
          workdir: this.workdir,
          resourceRoot: this.resourceRoot,
          psPath,
        }));
      } else {
        console.warn('[shell] PowerShell is enabled but was not found on this system. Skipping PowerShell tool.');
      }
    }

    return tools;
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
export { createShellCommandTool, runShellCommand, findGitBashPath } from './tools.js';
export type { ShellCommandToolOptions, ShellExecutionResult } from './tools.js';
export { createPowerShellTool, runPowerShellCommand, findPowerShellPath } from './powershell.js';

// 导出命令引用工具（供高级用户使用）
export {
  quoteShellCommand,
  shouldAddStdinRedirect,
  rewriteWindowsNullRedirect,
  containsHeredoc,
  hasStdinRedirect,
} from './shellQuoting.js';
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
