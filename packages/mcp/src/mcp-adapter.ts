/**
 * MCP Tool Adapter - 适配器模式实现
 *
 * 将 MCP 工具适配为现有 Tool 接口，保持架构一致性
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { withImages } from '@agentdevjs/core';
import type { Tool, ToolExecutionContext, ToolResultValue } from '@agentdevjs/core';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

/**
 * 注册工具的简化接口
 * 用于适配器包装
 */
interface RegisteredToolLike {
  name: string;
  description?: string;
  inputSchema?: any;
  outputSchema?: any;
  annotations?: any;
  handler?: (args: any, context?: any) => Promise<any> | any;
  enabled?: boolean;
}

/**
 * MCP 工具适配器配置
 */
export interface MCPToolAdapterConfig {
  /** MCP 服务器名称 */
  serverName: string;
  /** 是否为只读工具 */
  readOnly?: boolean;
  /** 图片快照目录，默认 ~/.agentdev/images；由宿主覆盖。 */
  storageDir?: string;
  /** 渲染模板覆盖 */
  render?: { call?: string; result?: string };
}

/**
 * MCP 工具适配器
 *
 * 将 MCP RegisteredTool 适配为 Agent 的 Tool 接口
 * 负责格式转换和生命周期管理
 */
export class MCPToolAdapter implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly render?: { call?: string; result?: string };

  constructor(
    private registeredTool: RegisteredToolLike,
    private config: MCPToolAdapterConfig
  ) {
    this.name = registeredTool.name;
    this.description = registeredTool.description || `MCP tool: ${registeredTool.name}`;
    this.parameters = this.extractParameters(registeredTool);
    this.render = {
      call: config.render?.call || 'mcp-tool',
      result: config.render?.result || 'mcp-tool',
    };
  }

  /**
   * 执行 MCP 工具
   */
  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResultValue> {
    const startTime = Date.now();

    try {
      const handler = this.registeredTool.handler;
      const result = await handler?.(args, context);

      const duration = Date.now() - startTime;

      // 转换结果格式
      return this.formatResult(result, duration);
    } catch (error) {
      // 错误处理
      return this.formatError(error, Date.now() - startTime);
    }
  }

  /**
   * 格式化 MCP 工具结果
   */
  private formatResult(result: any, duration: number): ToolResultValue {
    // 处理错误结果
    if (result && result.isError) {
      return {
        success: false,
        error: (result.content || []).map((c: any) => c.text || '').join('\n'),
        server: this.config.serverName,
        duration,
      };
    }

    // 提取文本内容
    const textContent = result.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text || '')
      .join('\n');

    // 返回格式化结果
    const formatted: Record<string, unknown> = {
      content: textContent,
      server: this.config.serverName,
      duration,
    };

    // 如果有结构化内容，附加到结果
    if ((result as any).structuredContent) {
      formatted.structuredContent = (result as any).structuredContent;
    }

    // 处理资源内容
    const resources = result.content.filter((c: any) => c.type === 'resource');
    if (resources.length > 0) {
      formatted.resources = resources.map((c: any) => ({
        uri: c.uri,
        mimeType: c.mimeType,
        text: c.text,
      }));
    }

    // 图片作为消息附件传递，不进入普通结果的 JSON 文本。
    const images = result.content.filter((c: any) => c.type === 'image');
    if (images.length > 0) {
      const storageDir = resolve(this.config.storageDir || join(homedir(), '.agentdev', 'images'));
      const attachments = images.map((c: any, index: number) => {
        const ext = IMAGE_EXTENSIONS[c.mimeType];
        if (!Object.hasOwn(IMAGE_EXTENSIONS, c.mimeType)) {
          throw new Error(`Unsupported MCP image MIME type: ${c.mimeType}`);
        }
        const data = Buffer.from(c.data, 'base64');
        const hash = createHash('sha256').update(c.data).digest('hex').slice(0, 32);
        const snapshotPath = join(storageDir, `${hash}.${ext}`);
        mkdirSync(storageDir, { recursive: true });
        if (!existsSync(snapshotPath) || !readFileSync(snapshotPath).equals(data)) {
          writeFileSync(snapshotPath, data);
        }
        return {
          path: snapshotPath,
          mediaType: c.mimeType,
          source: `${this.config.serverName}/${this.name} image ${index + 1}`,
        };
      });
      return { ...withImages(JSON.stringify(formatted), attachments) };
    }

    return formatted;
  }

  /**
   * 格式化错误
   */
  private formatError(error: unknown, duration: number): Record<string, unknown> {
    const errorMessage = error instanceof Error
      ? error.message
      : String(error);

    return {
      success: false,
      error: `[MCP Error] ${errorMessage}`,
      server: this.config.serverName,
      duration,
    };
  }

  /**
   * 从 RegisteredToolLike 提取参数定义
   *
   * MCP 工具的 inputSchema 已经是 JSON Schema 格式
   * 直接返回，不需要转换
   */
  private extractParameters(tool: RegisteredToolLike): Record<string, any> | undefined {
    // 如果没有 inputSchema，返回 undefined
    if (!tool.inputSchema) return undefined;

    // MCP 服务器返回的 inputSchema 已经是 JSON Schema 格式
    // 例如：{ type: 'object', properties: { owner: { type: 'string', description: '...' } } }
    // 直接返回，框架会使用它来生成工具描述给 LLM
    try {
      // 验证它是有效的 JSON Schema 对象
      const schema = tool.inputSchema;
      if (typeof schema === 'object' && schema.type === 'object') {
        return schema as Record<string, any>;
      }

      // 如果格式不符合预期，返回 undefined 让框架使用默认处理
      console.warn(`[MCPToolAdapter] Unexpected inputSchema format for ${tool.name}:`, typeof schema);
      return undefined;
    } catch (error) {
      console.warn(`[MCPToolAdapter] Failed to extract parameters for ${tool.name}:`, error);
      return undefined;
    }
  }
}

/**
 * 批量创建 MCP 工具适配器
 */
export function createMCPToolAdapters(
  registeredTools: RegisteredToolLike[],
  serverName: string,
  config?: Omit<MCPToolAdapterConfig, 'serverName'>
): Tool[] {
  return registeredTools.map(tool =>
    new MCPToolAdapter(tool, {
      serverName,
      ...config,
    })
  );
}
