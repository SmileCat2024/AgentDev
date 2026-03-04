/**
 * Shell Feature - Git Bash 命令执行工具
 *
 * 通过 Git Bash 执行 Shell 命令，description 从外部文件异步加载
 *
 * @example
 * ```typescript
 * import { ShellFeature } from './features/index.js';
 * const agent = new Agent({ ... }).use(new ShellFeature());
 * ```
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { cwd } from 'process';
import type { AgentFeature, FeatureInitContext } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import { createShellCommandTool } from './tools.js';

/**
 * Shell Feature 实现
 */
export class ShellFeature implements AgentFeature {
  readonly name = 'shell';
  readonly dependencies: string[] = [];

  private description?: string;

  /**
   * 获取同步工具（无）
   */
  getTools(): Tool[] {
    return [];
  }

  /**
   * 获取异步工具（加载 description）
   */
  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    // 首次调用时加载 description
    if (!this.description) {
      try {
        const descriptionPath = resolve(cwd(), '.agentdev/prompts/tool-bash.md');
        this.description = await readFile(descriptionPath, 'utf-8');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[ShellFeature] 加载 description 失败: ${errorMsg}`);
        this.description = '执行 Shell 命令（通过 Git Bash）';
      }
    }

    return [createShellCommandTool(this.description)];
  }

  /**
   * 模板路径声明（内联模板，无需声明）
   */
  getTemplatePaths(): Record<string, string> {
    return {};
  }
}
