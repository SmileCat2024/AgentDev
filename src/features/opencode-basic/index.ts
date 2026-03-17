/**
 * OpencodeBasicFeature - 基础文件操作工具集
 * 来自 opencode 项目的优秀基础文件工具实现
 *
 * 包含工具：
 * - read: 文件读取（支持 offset/limit 分页）
 * - write: 文件写入（覆盖模式）
 * - edit: 文件编辑（智能匹配策略）
 * - ls: 目录列表（树形结构）
 * - glob: 文件模式搜索
 * - grep: 内容搜索（基于 ripgrep）
 *
 * 安全机制：
 * - "先读后写"保护：write 工具前必须先 read 过该文件
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { promises as fs } from 'fs';
import type { AgentFeature, FeatureStateSnapshot, PackageInfo } from '../../core/feature.js';
import type { ToolContext } from '../../core/lifecycle.js';
import { ToolUse, Decision } from '../../core/hooks-decorator.js';
import type { FeatureInitContext } from '../../core/feature.js';
import type { DecisionResult } from '../../core/lifecycle.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { readTool, writeTool, editTool, lsTool, globTool, grepTool } from './tools.js';

const __filename = fileURLToPath(import.meta.url);

/**
 * OpencodeBasic Feature - 基础文件操作工具集
 */
export class OpencodeBasicFeature implements AgentFeature {
  readonly name = 'opencode-basic';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '提供读写文件、编辑、列目录、glob 和 grep 等基础工程化工具。包含"先读后写"安全保护机制。';

  /**
   * 存储已读取文件的路径（绝对路径）
   * 在整个 Session 生命周期中保持，用于验证 write 操作
   */
  private readFiles = new Set<string>();

  /**
   * 缓存包信息
   */
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
      'read',
      'write',
      'edit',
      'ls',
      'glob',
      'grep',
    ];
  }

  /**
   * Logger 实例，用于记录结构化日志
   */
  private logger: any;

  /**
   * Feature 初始化时清空读取历史
   */
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.readFiles.clear();
    this.logger = ctx.logger;
    this.logger?.info('OpencodeBasic read history initialized', {
      feature: 'opencode-basic',
      lifecycle: 'AgentInitiate'
    });
  }

  captureState(): FeatureStateSnapshot {
    return {
      readFiles: Array.from(this.readFiles),
    };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as { readFiles?: string[] };
    this.readFiles = new Set(state.readFiles ?? []);
  }

  /**
   * 工具使用前拦截器
   * - 记录 read 操作的文件路径
   * - 验证 write 操作是否已先读取
   */
  @ToolUse
  async validateWriteOperation(ctx: ToolContext): Promise<DecisionResult> {
    const toolName = ctx.call.name;

    // 记录 read 操作
    if (toolName === 'read') {
      const filePath = ctx.call.arguments?.filePath as string;
      const normalizedPath = resolve(filePath);
      this.readFiles.add(normalizedPath);

      this.logger?.info('File read tracked', {
        filePath: normalizedPath,
        totalReadFiles: this.readFiles.size,
        feature: 'opencode-basic',
        lifecycle: 'ToolUse',
        hookMethod: 'validateWriteOperation'
      });

      return Decision.Continue;
    }

    // 验证 write 操作
    if (toolName === 'write') {
      const filePath = ctx.call.arguments?.filePath as string;
      const normalizedPath = resolve(filePath);

      // 检查文件是否存在
      const exists = await fs.stat(normalizedPath)
        .then(() => true)
        .catch(() => false);

      // 新建文件，允许
      if (!exists) {
        this.logger?.info('Write allowed for new file', {
          filePath: normalizedPath,
          feature: 'opencode-basic',
          lifecycle: 'ToolUse',
          hookMethod: 'validateWriteOperation'
        });
        return Decision.Continue;
      }

      // 修改现有文件，检查是否已读
      if (!this.readFiles.has(normalizedPath)) {
        this.logger?.warn('Write blocked: file not read in this session', {
          filePath: normalizedPath,
          readFiles: Array.from(this.readFiles),
          feature: 'opencode-basic',
          lifecycle: 'ToolUse',
          hookMethod: 'validateWriteOperation'
        });

        return {
          action: Decision.Deny,
          reason: `文件 ${filePath} 在当前会话中未读取过。请先使用 read 工具查看文件内容后再进行修改。`
        };
      }

      this.logger?.info('Write allowed: file was read previously', {
        filePath: normalizedPath,
        feature: 'opencode-basic',
        lifecycle: 'ToolUse',
        hookMethod: 'validateWriteOperation'
      });

      return Decision.Continue;
    }

    // 其他工具，放行
    return Decision.Continue;
  }

  /**
   * 获取所有工具
   */
  getTools() {
    return [
      readTool,
      writeTool,
      editTool,
      lsTool,
      globTool,
      grepTool,
    ];
  }

}
