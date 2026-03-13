/**
 * MemoryFeature - 读取 CLAUDE.md 并注入到上下文
 *
 * 功能：
 * - 仅在首次对话开始前（CallStart）读取当前工作目录的 CLAUDE.md 文件
 * - 如果文件存在，将其作为系统消息注入到上下文中
 * - 后续轮次不再重复注入
 */

import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { AgentFeature, FeatureInitContext, FeatureContext } from '../../core/feature.js';
import { CallStart } from '../../core/hooks-decorator.js';

export interface MemoryFeatureConfig {
  /** CLAUDE.md 文件名，默认 'CLAUDE.md' */
  filename?: string;
  /** 是否强制注入，即使文件不存在也记录日志 */
  forceInject?: boolean;
}

export class MemoryFeature implements AgentFeature {
  readonly name = 'memory';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\\\/g, '/');
  readonly description = '自动读取并注入项目 CLAUDE.md 文件作为系统提示词。';

  private filename: string;
  private cwd: string | undefined;

  constructor(config: MemoryFeatureConfig = {}) {
    this.filename = config.filename ?? 'CLAUDE.md';
  }

  getTemplatePaths(): Record<string, string> {
    return {};
  }

  /**
   * CallStart 钩子：仅在首次对话开始时注入 CLAUDE.md 内容
   */
  @CallStart
  async injectCLAUDEContent(
    ctx: import('../../core/lifecycle.js').CallStartContext
  ): Promise<void> {
    // 只在首轮注入
    if (!ctx.isFirstCall) {
      return;
    }

    // 获取当前工作目录
    const cwd = process.cwd();

    // 查找 CLAUDE.md 文件
    const filePath = resolve(cwd, this.filename);

    // 检查文件是否存在
    if (!existsSync(filePath)) {
      // 文件不存在，不做任何操作
      return;
    }

    // 读取文件内容
    const content = readFileSync(filePath, 'utf-8');

    // 如果内容为空，跳过注入
    if (!content || content.trim().length === 0) {
      return;
    }

    // 注入为系统消息
    ctx.context.add({ role: 'system', content });
  }

  /**
   * 获取钩子描述（用于调试器）
   */
  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'CallStart' && methodName === 'injectCLAUDEContent') {
      return '仅在首次对话开始前读取并注入 CLAUDE.md 文件内容';
    }
    return undefined;
  }
}
