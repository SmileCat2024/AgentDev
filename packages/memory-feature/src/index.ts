/**
 * MemoryFeature - 读取项目文档（如 CLAUDE.md）并注入到上下文
 *
 * 功能：
 * - 仅在首次对话开始前（CallStart）读取工作目录下的指定文档文件
 * - 如果文件存在，将其作为系统消息注入到上下文中
 * - 后续轮次不再重复注入
 * - 支持配置多个文档文件，相对路径以工作目录为基准
 */

import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import type { AgentFeature, FeatureInitContext, FeatureContext, PackageInfo, FeatureStateSnapshot, FeatureManifestDefinition } from 'agentdev';
import { getPackageInfoFromSource } from 'agentdev';
import { CallStart } from 'agentdev';

export interface MemoryFeatureConfig {
  /** 读取 CLAUDE.md 的工作目录 */
  workspaceDir?: string;
  /** 宿主资源目录；如果提供，优先从这里读取文档 */
  resourceRoot?: string;
  /** 文档文件列表（相对路径以 workspaceDir 为基准），默认 ['CLAUDE.md'] */
  documents?: string[];
}

export class MemoryFeature implements AgentFeature {
  readonly name = 'memory';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '自动读取并注入项目文档文件（如 CLAUDE.md）作为系统提示词。';

  private documents: string[];
  private baseDir: string;
  private _packageInfo: PackageInfo | null = null;
  private _injected = false;

  constructor(config: MemoryFeatureConfig = {}) {
    this.documents = Array.isArray(config.documents) && config.documents.length > 0
      ? config.documents.filter(d => typeof d === 'string' && d.trim())
      : ['CLAUDE.md', 'AGENT.md'];
    this.baseDir = config.resourceRoot ?? config.workspaceDir ?? process.cwd();
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
   * 此 Feature 没有模板，返回空数组
   */
  getTemplateNames(): string[] {
    return [];
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1 as const,
      settings: {
        properties: {
          readClaudeMd: {
            type: 'boolean' as const,
            title: 'CLAUDE.md',
            description: '读取工作目录下的 CLAUDE.md 文件',
            default: true,
          },
          readAgentMd: {
            type: 'boolean' as const,
            title: 'AGENT.md',
            description: '读取工作目录下的 AGENT.md 文件',
            default: true,
          },
          extraDocs: {
            type: 'file' as const,
            title: '自定义文档',
            description: '额外的文档文件路径。相对路径（如 docs/RULES.md）以工作目录为基准，绝对路径直接使用。',
            default: [],
            maxItems: 10,
            accept: '.md,.txt',
          },
        },
      },
    };
  }

  /**
   * 初始化钩子：从 featureConfig 读取运行时配置，覆盖构造函数默认值
   */
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    const wsDir = ctx.config?.workspaceDir;
    if (wsDir) {
      this.baseDir = wsDir;
    }

    const fc = ctx.featureConfig;
    if (fc && typeof fc === 'object') {
      const c = fc as Record<string, unknown>;
      const docs: string[] = [];

      if (c.readClaudeMd !== false) docs.push('CLAUDE.md');
      if (c.readAgentMd !== false) docs.push('AGENT.md');

      if (Array.isArray(c.extraDocs)) {
        for (const d of c.extraDocs) {
          if (typeof d === 'string' && d.trim()) {
            docs.push(d.trim());
          }
        }
      }

      this.documents = docs;
    }
  }

  /**
   * CallStart 钩子：仅在首次对话开始时注入文档内容
   */
  @CallStart
  async injectCLAUDEContent(
    ctx: import('agentdev').CallStartContext
  ): Promise<void> {
    // 只在首轮注入
    if (!ctx.isFirstCall) {
      return;
    }

    // 防止回退后重复注入（rollback 恢复 injected=true 时直接跳过）
    if (this._injected) {
      return;
    }

    // 每个文档作为独立的系统消息注入
    let injected = false;
    for (const doc of this.documents) {
      const filePath = isAbsolute(doc) ? doc : resolve(this.baseDir, doc);
      if (!existsSync(filePath)) {
        continue;
      }
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content && content.trim().length > 0) {
          ctx.context.add({ role: 'system', content });
          injected = true;
        }
      } catch {
        // 容错：跳过读取失败的文件
      }
    }

    if (!injected) {
      return;
    }
    this._injected = true;
  }

  captureState(): FeatureStateSnapshot {
    return { injected: this._injected };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    this._injected = Boolean((snapshot as any)?.injected);
  }

  /**
   * 获取钩子描述（用于调试器）
   */
  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'CallStart' && methodName === 'injectCLAUDEContent') {
      return '仅在首次对话开始前读取并注入项目文档文件内容';
    }
    return undefined;
  }
}
