/**
 * OutputGuard Feature - 工具输出安全网
 *
 * 框架级 Feature，通过 ToolResultTransform 钩子在工具结果写入 context 前进行截断。
 *
 * 设计层次：
 * - Layer 0（工具自截断）：工具在自己的 execute() 中自行截断（如 shell 的 30K）。
 *   只要结果在 hardLimit 以下，OutputGuard 不会介入。
 * - Layer 1（安全网）：OutputGuard 在 ToolResultTransform 钩子中捕获超限结果，
 *   使用级联截断策略（JSON 字段截断 → 行感知 head+tail → 字符 head+tail）。
 *
 * @example
 * ```typescript
 * import { OutputGuardFeature } from '@agentdev/core';
 * const agent = new Agent({ ... }).use(new OutputGuardFeature());
 * ```
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import type {
  AgentFeature,
  FeatureInitContext,
  FeatureContext,
  ContextInjector,
  PackageInfo,
  FeatureStateSnapshot,
} from '../../core/feature.js';
import type { HookDeclarations } from '../../core/hook-declarations.js';
import { CoreLifecycle } from '../../core/lifecycle.js';
import type { Tool } from '../../core/types.js';
import type { ToolResultTransformContext } from '../../core/lifecycle.js';
import type { ToolExecResult } from '../../core/context.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import {
  truncateOutput,
  DEFAULT_HARD_LIMIT,
  DEFAULT_FIELD_LIMIT,
} from './truncate.js';
import type { TruncateOptions } from './truncate.js';

// ========== 类型定义 ==========

export interface OutputGuardConfig {
  /** 总体积硬限制（默认 50000 字符） */
  hardLimit?: number;
  /** 单个字符串字段截断长度（默认 5000 字符） */
  fieldLimit?: number;
  /** 按工具名覆盖配置 */
  toolOverrides?: Record<string, { hardLimit?: number; fieldLimit?: number }>;
  /** 工作目录，用于持久化截断内容（默认 process.cwd()） */
  workdir?: string;
}

// ========== Feature 实现 ==========

export class OutputGuardFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    handleToolResultTransform: { lifecycle: CoreLifecycle.ToolResultTransform, kind: 'transform' as const },
  };
  readonly name = 'output-guard';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description =
    '工具输出安全网：在工具结果写入 context 前截断超限输出，防止上下文溢出。';

  private readonly config: Required<Omit<OutputGuardConfig, 'toolOverrides'>> & {
    toolOverrides: Record<string, { hardLimit?: number; fieldLimit?: number }>;
  };

  private logger?: FeatureInitContext['logger'];
  private _packageInfo: PackageInfo | null = null;
  private truncateCount = 0;

  constructor(config: OutputGuardConfig = {}) {
    this.config = {
      hardLimit: config.hardLimit ?? DEFAULT_HARD_LIMIT,
      fieldLimit: config.fieldLimit ?? DEFAULT_FIELD_LIMIT,
      workdir: config.workdir ?? process.cwd(),
      toolOverrides: config.toolOverrides ?? {},
    };
  }

  // ========== AgentFeature 接口实现 ==========

  getTools(): Tool[] {
    return []; // 纯钩子 Feature，不注册工具
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  getTemplateNames(): string[] {
    return [];
  }

  getContextInjectors(): Map<string | RegExp, ContextInjector> {
    return new Map();
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('OutputGuardFeature initiated', {
      hardLimit: this.config.hardLimit,
      fieldLimit: this.config.fieldLimit,
    });
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    this.logger?.info('OutputGuardFeature destroyed', {
      totalTruncations: this.truncateCount,
    });
  }

  captureState(): FeatureStateSnapshot {
    return { truncateCount: this.truncateCount };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as { truncateCount?: number } | null;
    this.truncateCount = typeof state?.truncateCount === 'number' ? state.truncateCount : 0;
  }

  async beforeRollback(_snapshot: FeatureStateSnapshot): Promise<void> {}
  async afterRollback(_snapshot: FeatureStateSnapshot): Promise<void> {}

  // ========== ToolResultTransform 钩子 ==========

  async handleToolResultTransform(
    ctx: ToolResultTransformContext,
  ): Promise<ToolExecResult | undefined> {
    const { result, toolName } = ctx;

    // 只处理成功的结果（错误结果通常很短）
    if (!result.success) return undefined;

    // result.result 可能是 string 或 Record<string, any>
    // 统一转为字符串进行截断判断
    const rawResult = result.result;
    const resultStr = typeof rawResult === 'string'
      ? rawResult
      : JSON.stringify(rawResult);

    // 获取该工具的配置覆盖
    const options = this.getOptions(toolName);

    // 执行截断
    const truncateResult = truncateOutput(resultStr, options);

    // 不超限，不修改
    if (!truncateResult.truncated) return undefined;

    // 记录截断
    this.truncateCount++;
    this.logger?.warn('Tool output truncated', {
      toolName,
      strategy: truncateResult.strategy,
      originalLength: truncateResult.originalLength,
      truncatedLength: truncateResult.truncatedLength,
    });

    // 持久化完整输出到磁盘，并将文件路径注入截断结果
    const finalOutput = await this.persistAndAnnotate(
      truncateResult.output,
      truncateResult.strategy,
      resultStr,
      truncateResult.originalLength,
      toolName,
    );

    // 返回截断后的结果
    return {
      ...result,
      result: finalOutput,
    };
  }

  // ========== 内部方法 ==========

  private getOptions(toolName: string): TruncateOptions {
    const override = this.config.toolOverrides[toolName];
    return {
      hardLimit: override?.hardLimit ?? this.config.hardLimit,
      fieldLimit: override?.fieldLimit ?? this.config.fieldLimit,
    };
  }

  /**
   * 将完整输出持久化到磁盘，并在截断结果中注入文件路径引用。
   *
   * - JSON 结果：在顶层对象中注入 `_outputGuard` 字段（保持 JSON 合法性）
   * - 文本结果：在头部插入提示行（与 shell 工具风格一致）
   *
   * 如果落盘失败（权限、磁盘满等），不注入路径引用，截断结果照常返回。
   */
  private async persistAndAnnotate(
    truncatedOutput: string,
    strategy: string,
    fullOutput: string,
    originalLength: number,
    toolName: string,
  ): Promise<string> {
    // 尝试落盘
    let filePath: string | null;
    let diskContent = fullOutput;
    try {
      const tempDir = join(this.config.workdir, '.agentdev', 'temp');
      const now = new Date();
      const ts = now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + '-' +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');
      const suffix = Math.random().toString(36).slice(2, 8);
      const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
      const fileName = `tool-output-${safeToolName}-${ts}-${suffix}.log`;
      filePath = join(tempDir, fileName);

      // 尝试 pretty-print JSON 以便 read 工具按行分页
      try {
        const parsed = JSON.parse(fullOutput);
        diskContent = JSON.stringify(parsed, null, 2);
      } catch {
        // 非 JSON 文本，保持原始换行
      }

      await mkdir(tempDir, { recursive: true });
      await writeFile(filePath, diskContent, 'utf-8');
    } catch (err) {
      this.logger?.error('Failed to persist truncated output', { error: String(err) });
      filePath = null;
    }

    // 落盘失败，原样返回截断结果
    if (!filePath) return truncatedOutput;

    const totalKB = Math.round(originalLength / 1024);
    const totalLines = diskContent.split('\n').length;

    // 根据截断策略决定注入方式
    const isJsonStrategy = strategy === 'json-fields' || strategy === 'json-array';

    if (isJsonStrategy) {
      // JSON 结果：在顶层注入 _outputGuard 字段
      try {
        const parsed = JSON.parse(truncatedOutput);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsed._outputGuard = {
            fullOutputPath: filePath,
            originalSize: originalLength,
            originalSizeKB: totalKB,
            originalLines: totalLines,
          };
          return JSON.stringify(parsed);
        }
      } catch {
        // 截断后不是合法 JSON（理论上不应发生，但防御性处理）
      }
      // 如果 JSON 注入失败，回退到文本方式
    }

    // 文本结果：在头部插入提示
    const notice =
      `[OutputGuard: full output (${totalKB}KB, ${totalLines} lines) saved to: ${filePath}]\n` +
      `Use the read tool with offset/limit to access specific portions.\n`;
    return notice + truncatedOutput;
  }
}
