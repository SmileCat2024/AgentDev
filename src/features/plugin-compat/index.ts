/**
 * OpenClaw 插件兼容层 Feature
 *
 * 负责加载和管理 OpenClaw 风格的插件
 */

import { resolve } from 'path';
import type { AgentFeature, FeatureInitContext, FeatureContext } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import { ToolRegistry } from '../../core/tool.js';
import type {
  OpenClawPluginManifest,
  PluginCompatConfig,
  CompatHookName,
  CompatHookHandlerMap,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
} from './types.js';
import {
  discoverPluginRoots,
  parsePluginManifest,
  validatePluginManifest,
} from './manifest.js';
import { createCompatApi, createPluginLogger } from './api.js';
import { CompatHookRegistry } from './registry.js';
import { DiagnosticsCollector } from './diagnostics.js';
import { ToolUse, ToolFinished, Decision } from '../../core/hooks-decorator.js';
import type { ToolContext, ToolResult } from '../../core/lifecycle.js';

/**
 * PluginCompatFeature
 *
 * 加载 OpenClaw 风格插件并将它们转换为 AgentDev 能力
 */
export class PluginCompatFeature implements AgentFeature {
  name = 'plugin-compat';

  /** 兼容钩子注册表 */
  private compatHookRegistry = new CompatHookRegistry();

  /** 诊断收集器 */
  private diagnostics = new DiagnosticsCollector();

  /** 已加载的插件 */
  private loadedPlugins = new Map<string, OpenClawPluginManifest>();

  /** Agent 工具注册表（从 FeatureContext 获取） */
  private agentToolRegistry?: ToolRegistry;

  /** Agent ID */
  private agentId?: string;

  /** 插件根目录 */
  private pluginRoots: string[] = [];

  /** 是否启用 */
  private enabled = false;

  /** 注册的工具列表（用于 getAsyncTools） */
  private registeredTools: Tool[] = [];

  /**
   * 初始化 Feature
   */
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    const config = ctx.featureConfig as PluginCompatConfig | undefined;
    this.enabled = config?.enabled ?? false;
    this.agentId = ctx.agentId;

    if (!this.enabled) {
      return;
    }

    // 获取插件根目录（默认：.agentdev/plugins）
    this.pluginRoots = config?.pluginRoots ?? [resolve(process.cwd(), '.agentdev/plugins')];

    // 加载插件
    await this.loadPlugins();

    // 输出诊断报告
    this.diagnostics.printReport();
  }

  /**
   * 加载所有插件
   */
  private async loadPlugins(): Promise<void> {
    // 发现插件根目录
    const roots = await discoverPluginRoots(this.pluginRoots);

    if (roots.length === 0) {
      console.log('[PluginCompat] No plugin roots found');
      return;
    }

    console.log(`[PluginCompat] Found ${roots.length} plugin root(s)`);

    // 加载每个插件
    for (const root of roots) {
      await this.loadPlugin(root);
    }
  }

  /**
   * 加载单个插件
   */
  private async loadPlugin(pluginRoot: string): Promise<void> {
    try {
      // 解析清单
      const manifest = await parsePluginManifest(pluginRoot);

      // 验证清单
      const validation = validatePluginManifest(manifest);
      if (!validation.valid) {
        throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`);
      }

      // 检查重复 ID
      if (this.loadedPlugins.has(manifest.id)) {
        throw new Error(`Plugin ID already loaded: ${manifest.id}`);
      }

      // 创建诊断记录
      this.diagnostics.getOrCreate(manifest.id, {
        name: manifest.name,
        version: manifest.version,
        source: pluginRoot,
      });

      // 动态导入插件入口
      const entryPath = resolve(pluginRoot, manifest.main);
      const pluginModule = await import(entryPath);

      // 获取插件注册函数
      const registerFn = pluginModule.register || pluginModule.default;

      if (typeof registerFn !== 'function') {
        throw new Error(`Plugin must export a register() function or default export`);
      }

      // 创建兼容 API
      const api = createCompatApi(
        manifest.id,
        pluginRoot,
        {}, // agentConfig (简化版，可后续扩展)
        manifest.configSchema as any, // pluginConfig
        (tool) => this.registerTool(manifest.id, tool),
        (hookName, handler, priority) => this.registerHook(manifest.id, hookName, handler, priority),
        (name, params) => this.invokeTool(name, params),
        {
          unsupportedApi: (apiName) => this.diagnostics.recordUnsupportedApi(manifest.id, apiName),
        }
      );

      // 调用插件注册函数
      await registerFn(api);

      // 记录已加载插件
      this.loadedPlugins.set(manifest.id, manifest);

      console.log(`[PluginCompat] ✓ Loaded plugin: ${manifest.name} (${manifest.id}) v${manifest.version}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[PluginCompat] ✗ Failed to load plugin from ${pluginRoot}: ${message}`);
    }
  }

  /**
   * 注册工具
   */
  private registerTool(pluginId: string, tool: Tool): void {
    // 记录到本地列表
    this.registeredTools.push(tool);

    // 如果有 agentToolRegistry，也注册到那里
    if (this.agentToolRegistry) {
      this.agentToolRegistry.register(tool, this.name);
    }

    // 记录诊断
    this.diagnostics.recordTool(pluginId, tool.name);
  }

  /**
   * 获取异步工具列表
   */
  async getAsyncTools(): Promise<Tool[]> {
    return this.registeredTools;
  }

  /**
   * 注册钩子
   */
  private registerHook(
    pluginId: string,
    hookName: CompatHookName,
    handler: CompatHookHandlerMap[CompatHookName],
    priority: number
  ): void {
    this.compatHookRegistry.register(hookName, handler, priority, pluginId);
    this.diagnostics.recordHook(pluginId, hookName);
  }

  /**
   * 调用工具（用于插件运行时）
   */
  private async invokeTool(name: string, params: unknown): Promise<unknown> {
    if (!this.agentToolRegistry) {
      throw new Error(`Tool registry not available`);
    }

    const tool = this.agentToolRegistry.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    return tool.execute(params);
  }

  /**
   * 获取兼容钩子注册表（供内部桥接使用）
   */
  getCompatHookRegistry(): CompatHookRegistry {
    return this.compatHookRegistry;
  }

  /**
   * 获取诊断报告
   */
  getDiagnostics() {
    return this.diagnostics.generateReport();
  }

  /**
   * 清理资源
   */
  async onDestroy(): Promise<void> {
    this.compatHookRegistry.clear();
    this.diagnostics.clear();
    this.loadedPlugins.clear();
    this.registeredTools = [];
  }

  // ========== 反向钩子装饰器（桥接兼容层）==========

  /**
   * 桥接 before_tool_call 钩子
   *
   * 在工具执行前调用兼容插件的 before_tool_call 钩子
   */
  @ToolUse
  async handleBeforeToolCall(ctx: ToolContext): Promise<typeof Decision.Deny | typeof Decision.Continue> {
    if (!this.compatHookRegistry.has('before_tool_call')) {
      return Decision.Continue;
    }

    // 转换上下文
    const compatContext: BeforeToolCallContext = {
      call: ctx.call,
      toolName: ctx.call.name,
      parameters: ctx.call.arguments,
      messages: ctx.context.getAll(),
    };

    // 执行兼容钩子
    const result = await this.compatHookRegistry.executeBeforeToolCall(compatContext);

    if (result.block) {
      return Decision.Deny;
    }

    // 如果有参数修改，应用到工具调用（创建新对象避免直接修改）
    if (result.rewrittenParameters) {
      Object.assign(ctx.call.arguments, result.rewrittenParameters);
    }

    return Decision.Continue;
  }

  /**
   * 桥接 after_tool_call 钩子
   *
   * 在工具执行后调用兼容插件的 after_tool_call 钩子
   */
  @ToolFinished
  async handleAfterToolCall(result: ToolResult): Promise<void> {
    if (!this.compatHookRegistry.has('after_tool_call')) {
      return;
    }

    // 转换上下文
    const compatContext: AfterToolCallContext = {
      call: result.call,
      toolName: result.call.name,
      success: result.success,
      result: result.data,
      error: result.error,
      duration: result.duration,
      messages: result.context.getAll(),
    };

    // 执行兼容钩子
    await this.compatHookRegistry.executeAfterToolCall(compatContext);
  }
}
