/**
 * Feature System - 可外挂功能模块接口
 *
 * Feature 系统允许将功能（MCP、Skills、子代理等）从 Agent 核心中解耦，
 * 实现新功能的声明式注册和统一的生命周期管理。
 */

import type { Tool } from './types.js';
import type { ToolCall } from './types.js';
import type { InlineRenderTemplate } from './types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';

/**
 * Feature 上下文值类型
 */
export type ToolContextValue = Record<string, unknown>;

/**
 * Feature 上下文注入器
 * 返回要注入到 tool.execute() 的额外参数
 */
export type ContextInjector = (call: ToolCall) => ToolContextValue;

/**
 * Feature 初始化上下文
 */
export interface FeatureInitContext {
  /** Agent ID */
  agentId: string;
  /** Agent 配置 */
  config: import('./types.js').AgentConfig;
  /** Feature 级结构化日志 */
  logger: import('./logging.js').Logger;
  /** Feature 特定配置 */
  featureConfig?: unknown;
  /** 获取其他 Feature */
  getFeature<T extends AgentFeature>(name: string): T | undefined;
  /** 注册工具 */
  registerTool(tool: Tool): void;
}

/**
 * Feature 运行时上下文
 */
export interface FeatureContext {
  agentId: string;
  config: import('./types.js').AgentConfig;
}

/**
 * Feature 快照状态
 *
 * 第一阶段只支持显式白名单状态：
 * - Feature 自己决定要保存什么
 * - 未声明的状态一律不保证恢复
 */
export type FeatureStateSnapshot = unknown;

/**
 * 包信息
 */
export interface PackageInfo {
  /** 包名，如 '@agentdev/shell-feature' 或 'agentdev' */
  name: string;
  /** 版本号（可选） */
  version?: string;
  /** 包根目录绝对路径 */
  root: string;
}

/**
 * 模板信息
 */
export interface TemplateInfo {
  /** 包名 */
  packageName: string;
  /** 模板名（不含扩展名） */
  templateName: string;
}

// ========== 正向钩子（纯通知，void 返回）==========

/**
 * Feature 初始化上下文
 */
export interface FeatureInitContext {
  /** Agent ID */
  agentId: string;
  /** Agent 配置 */
  config: import('./types.js').AgentConfig;
  /** Feature 级结构化日志 */
  logger: import('./logging.js').Logger;
  /** Feature 特定配置 */
  featureConfig?: unknown;
  /** 获取其他 Feature */
  getFeature<T extends AgentFeature>(name: string): T | undefined;
  /** 注册工具 */
  registerTool(tool: Tool): void;
}

/**
 * Agent Feature 接口
 *
 * 可外挂的功能模块，提供工具和上下文注入
 */
export interface AgentFeature {
  /** Feature 名称 */
  readonly name: string;
  /** 依赖的其他 Feature */
  readonly dependencies?: string[];
  /** 可选：用于调试器展示的源码位置 */
  readonly source?: string;
  /** 可选：用于调试器展示的 Feature 描述 */
  readonly description?: string;

  /**
   * 获取同步工具（已知工具列表）
   */
  getTools?(): Tool[];

  /**
   * 获取异步工具（需要连接、发现等）
   */
  getAsyncTools?(ctx: FeatureInitContext): Promise<Tool[]>;

  /**
   * 获取包信息
   * 
   * 返回 Feature 所在的包信息（包名、版本、根目录）
   * 用于统一模板路径解析和包管理
   * 
   * @returns 包信息，如果 Feature 不属于任何包则返回 null
   * 
   * @example
   * ```typescript
   * getPackageInfo(): PackageInfo | null {
   *   return {
   *     name: '@agentdev/shell-feature',
   *     version: '1.0.0',
   *     root: '/path/to/package/root'
   *   };
   * }
   * ```
   */
  getPackageInfo?(): PackageInfo | null;

  /**
   * 获取模板名称列表
   * 
   * 返回 Feature 提供的模板名称列表（不含扩展名）
   * 模板文件必须位于 {packageRoot}/dist/templates/{templateName}.render.js
   * 
   * @returns 模板名称数组
   * 
   * @example
   * ```typescript
   * getTemplateNames(): string[] {
   *   return ['bash', 'trash-delete', 'trash-list'];
   * }
   * ```
   */
  getTemplateNames?(): string[];

  /**
   * 声明渲染模板（推荐方式）
   * 直接返回模板对象，无需文件路径
   *
   * @example
   * ```typescript
   * getRenderTemplates(): Record<string, InlineRenderTemplate> {
   *   return {
   *     'bash': {
   *       call: (args) => `<div class="bash-command">> ${escapeHtml(args.command)}</div>`,
   *       result: (data, success) => success
   *         ? `<pre class="bash-output">${escapeHtml(data)}</pre>`
   *         : `<div class="tool-error">${escapeHtml(data)}</div>`
   *     }
   *   };
   * }
   * ```
   */
  getRenderTemplates?(): Record<string, InlineRenderTemplate>;

  /**
   * 声明上下文注入器
   */
  getContextInjectors?(): Map<string | RegExp, ContextInjector>;

  /**
   * 初始化钩子
   */
  onInitiate?(ctx: FeatureInitContext): Promise<void>;

  /**
   * 清理钩子
   */
  onDestroy?(ctx: FeatureContext): Promise<void>;

  /**
   * 捕获可回滚的 Feature 状态
   *
   * 仅返回显式声明、可序列化的状态。
   * 未返回的字段不会参与 rollback。
   */
  captureState?(): FeatureStateSnapshot;

  /**
   * 从快照恢复 Feature 状态
   */
  restoreState?(snapshot: FeatureStateSnapshot): void | Promise<void>;

  /**
   * rollback 前钩子
   */
  beforeRollback?(snapshot: FeatureStateSnapshot): void | Promise<void>;

  /**
   * rollback 后钩子
   */
  afterRollback?(snapshot: FeatureStateSnapshot): void | Promise<void>;

  /**
   * 可选：为调试器提供 hook 的人类可读说明
   */
  getHookDescription?(lifecycle: string, methodName: string): string | undefined;

  // ========== 反向钩子通过装饰器注册，无需接口声明 ==========
  // 使用 hooks-decorator.ts 中提供的装饰器来标记反向钩子方法
  // 例如：@ToolFinished, @LLMFinish, @StepFinish 等
}

// ========== 辅助函数 ==========

/**
 * 从 Feature 的 source 属性获取包信息
 * 
 * 通过向上查找 package.json 文件来确定包信息
 * 支持三种场景：
 * 1. 框架内置 Feature：找到 AgentDev 的 package.json
 * 2. 外部 npm 包：找到包的 package.json
 * 3. 用户本地 Feature：找到用户项目的 package.json
 * 
 * @param source Feature 的源文件路径（import.meta.url）
 * @returns 包信息，如果找不到 package.json 则返回 null
 */
export function getPackageInfoFromSource(source: string | undefined): PackageInfo | null {
  if (!source) {
    return null;
  }

  try {
    // 将 file:// URL 转换为文件系统路径
    const filePath = source.startsWith('file://') ? fileURLToPath(source) : source;
    const featureDir = dirname(filePath);
    
    // 向上查找 package.json
    let currentDir = featureDir;
    const root = process.platform === 'win32' ? currentDir.split(/[/\\]/)[0] : '';
    
    while (currentDir && currentDir !== root) {
      try {
        const packageJsonPath = join(currentDir, 'package.json');
        
        // 检查文件是否存在
        if (!existsSync(packageJsonPath)) {
          throw new Error('Not found');
        }
        
        // 读取并解析 package.json
        const content = readFileSync(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);
        
        // 找到了 package.json
        return {
          name: packageJson.name || 'unknown',
          version: packageJson.version,
          root: currentDir,
        };
      } catch {
        // 没找到，继续向上查找
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) {
          // 已经到达根目录，停止查找
          break;
        }
        currentDir = parentDir;
      }
    }
    
    return null;
  } catch {
    // 任何错误都返回 null
    return null;
  }
}
