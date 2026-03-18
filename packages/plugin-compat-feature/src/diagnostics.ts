/**
 * 兼容层诊断模块
 *
 * 收集和输出插件加载、注册的诊断信息
 */

import type {
  PluginDiagnostics,
  CompatDiagnosticsReport,
  CompatHookName,
} from './types.js';

/**
 * 诊断收集器
 */
export class DiagnosticsCollector {
  /** 插件诊断信息映射 */
  private plugins = new Map<string, PluginDiagnostics>();

  /** 钩子去重缓存（用于快速查找） */
  private hooksCache = new Map<string, Set<CompatHookName>>();

  /**
   * 创建或获取插件诊断记录
   *
   * @param pluginId 插件 ID
   * @param metadata 插件元数据
   * @returns 诊断记录
   */
  getOrCreate(pluginId: string, metadata: {
    name: string;
    version: string;
    source: string;
  }): PluginDiagnostics {
    if (!this.plugins.has(pluginId)) {
      this.plugins.set(pluginId, {
        pluginId,
        name: metadata.name,
        version: metadata.version,
        source: metadata.source,
        registeredTools: [],
        registeredHooks: [],
        unsupportedApis: [],
        errors: [],
      });
      // 初始化钩子缓存
      this.hooksCache.set(pluginId, new Set());
    }
    return this.plugins.get(pluginId)!;
  }

  /**
   * 记录工具注册
   *
   * @param pluginId 插件 ID
   * @param toolName 工具名称
   */
  recordTool(pluginId: string, toolName: string): void {
    const diag = this.plugins.get(pluginId);
    if (diag) {
      diag.registeredTools.push(toolName);
    }
  }

  /**
   * 记录钩子注册（使用 Set 去重）
   *
   * @param pluginId 插件 ID
   * @param hookName 钩子名称
   */
  recordHook(pluginId: string, hookName: CompatHookName): void {
    const diag = this.plugins.get(pluginId);
    const hookSet = this.hooksCache.get(pluginId);

    if (diag && hookSet && !hookSet.has(hookName)) {
      hookSet.add(hookName);
      diag.registeredHooks.push(hookName);
    }
  }

  /**
   * 记录不支持 API 调用
   *
   * @param pluginId 插件 ID
   * @param apiName API 名称
   */
  recordUnsupportedApi(pluginId: string, apiName: string): void {
    const diag = this.plugins.get(pluginId);
    if (diag) {
      diag.unsupportedApis.push(apiName);
    }
  }

  /**
   * 记录错误
   *
   * @param pluginId 插件 ID
   * @param error 错误信息
   */
  recordError(pluginId: string, error: string): void {
    const diag = this.plugins.get(pluginId);
    if (diag) {
      diag.errors.push(error);
    }
  }

  /**
   * 生成诊断报告
   *
   * @returns 诊断报告
   */
  generateReport(): CompatDiagnosticsReport {
    const plugins = Array.from(this.plugins.values());

    return {
      plugins,
      totalTools: plugins.reduce((sum, p) => sum + p.registeredTools.length, 0),
      totalHooks: plugins.reduce((sum, p) => sum + p.registeredHooks.length, 0),
    };
  }

  /**
   * 输出诊断信息到控制台
   */
  printReport(): void {
    const report = this.generateReport();

    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log('║         OpenClaw Compatibility Layer Diagnostics             ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log(`\n📦 Loaded Plugins: ${report.plugins.length}`);
    console.log(`🔧 Registered Tools: ${report.totalTools}`);
    console.log(`🪝 Registered Hooks: ${report.totalHooks}`);

    for (const plugin of report.plugins) {
      console.log(`\n─── ${plugin.name} (${plugin.pluginId}) v${plugin.version} ───`);
      console.log(`   Source: ${plugin.source}`);

      if (plugin.registeredTools.length > 0) {
        console.log(`   ✅ Tools: ${plugin.registeredTools.join(', ')}`);
      }
      if (plugin.registeredHooks.length > 0) {
        console.log(`   ✅ Hooks: ${plugin.registeredHooks.join(', ')}`);
      }
      if (plugin.unsupportedApis.length > 0) {
        console.log(`   ⚠️  Unsupported APIs: ${plugin.unsupportedApis.join(', ')}`);
      }
      if (plugin.errors.length > 0) {
        console.log(`   ❌ Errors:`);
        for (const error of plugin.errors) {
          console.log(`      - ${error}`);
        }
      }
    }

    console.log('\n');
  }

  /**
   * 清空所有诊断记录
   */
  clear(): void {
    this.plugins.clear();
    this.hooksCache.clear();
  }
}
