/**
 * 模板解析器
 *
 * 负责系统提示词的解析和渲染
 */

import type { TemplateSource, PlaceholderContext } from '../../template/types.js';
import { TemplateComposer } from '../../template/composer.js';
import { type TemplateLoader } from '../../template/loader.js';
import type { DataSourceRegistry } from '../../template/data-source.js';

/**
 * 模板解析器类
 */
export class TemplateResolver {
  private systemMessage?: string | TemplateSource;
  private systemContext?: PlaceholderContext;
  private templateComposer?: TemplateComposer;
  private templateLoader: TemplateLoader;
  private dataSourceRegistry: DataSourceRegistry;

  constructor(
    systemMessage: string | TemplateSource | undefined,
    systemContext: PlaceholderContext | undefined,
    templateComposer: TemplateComposer | undefined,
    templateLoader: TemplateLoader,
    dataSourceRegistry: DataSourceRegistry
  ) {
    this.systemMessage = systemMessage;
    this.systemContext = systemContext;
    this.templateComposer = templateComposer;
    this.templateLoader = templateLoader;
    this.dataSourceRegistry = dataSourceRegistry;
  }

  /**
   * 设置新的系统消息
   */
  setSystemMessage(prompt: string | TemplateSource): void {
    // TemplateComposer 实例
    if (prompt instanceof TemplateComposer) {
      this.templateComposer = prompt;
      this.systemMessage = undefined;
    } else {
      // 字符串或 { file: string }
      this.systemMessage = prompt;
      this.templateComposer = undefined;
    }
  }

  /**
   * 设置系统上下文
   */
  setSystemContext(context: PlaceholderContext): void {
    this.systemContext = context;
  }

  /**
   * 获取当前系统上下文（可变引用）
   *
   * 供 Agent.setLLM() 更新 SYSTEM_CURRENT_MODEL 等占位符变量。
   */
  getSystemContext(): PlaceholderContext | undefined {
    return this.systemContext;
  }

  /**
   * 解析系统提示词（渲染模板）
   */
  async resolve(): Promise<string> {
    const context: PlaceholderContext = {
      ...this.systemContext,
    };

    // 直接字符串
    if (typeof this.systemMessage === 'string') {
      const { PlaceholderResolver } = await import('../../template/resolver.js');
      return PlaceholderResolver.resolve(this.systemMessage, context);
    }

    // TemplateComposer 实例
    if (this.templateComposer) {
      this.templateComposer.setDataSourceRegistry(this.dataSourceRegistry);
      const result = await this.templateComposer.render(context);
      return result.content;
    }

    // 文件路径 { file: string }
    if (this.systemMessage && typeof this.systemMessage === 'object' && 'file' in this.systemMessage) {
      const content = await this.templateLoader.load(this.systemMessage.file);
      const { PlaceholderResolver } = await import('../../template/resolver.js');
      return PlaceholderResolver.resolve(content, context);
    }

    return '';
  }
}
