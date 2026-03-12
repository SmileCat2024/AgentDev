/**
 * OpenClaw 兼容 API 实现
 *
 * 实现兼容 OpenClaw 插件的 API 接口
 */

import { isAbsolute } from 'path';
import type {
  AgentDevOpenClawCompatApi,
  PluginLogger,
  AgentDevOpenClawCompatRuntime,
  CompatTool,
  CompatToolFactory,
  CompatHookName,
  CompatHookHandlerMap,
} from './types.js';
import type { Tool } from '../../core/types.js';
import type { Context } from '../../core/context.js';
import { createLogger } from '../../core/logging.js';

/**
 * 创建插件日志记录器
 */
export function createPluginLogger(pluginId: string): PluginLogger {
  const logger = createLogger(`plugin.${pluginId}`, {
    feature: 'plugin-compat',
    tags: ['plugin', `plugin:${pluginId}`],
  });

  return {
    info: (message, ...args) => logger.info(message, args.length <= 1 ? args[0] : args),
    warn: (message, ...args) => logger.warn(message, args.length <= 1 ? args[0] : args),
    error: (message, ...args) => logger.error(message, args.length <= 1 ? args[0] : args),
    debug: (message, ...args) => logger.debug(message, args.length <= 1 ? args[0] : args),
  };
}

/**
 * 创建子日志记录器
 */
export function createChildLogger(
  parent: PluginLogger,
  bindings?: Record<string, unknown>
): PluginLogger {
  const prefix = bindings
    ? Object.entries(bindings).map(([k, v]) => `${k}=${v}`).join(' ')
    : '';

  return {
    info: (message, ...args) => parent.info(`[${prefix}]`, message, ...args),
    warn: (message, ...args) => parent.warn(`[${prefix}]`, message, ...args),
    error: (message, ...args) => parent.error(`[${prefix}]`, message, ...args),
    debug: (message, ...args) => parent.debug(`[${prefix}]`, message, ...args),
  };
}

/**
 * 路径解析器
 */
export function createPathResolver(pluginRoot: string): (input: string) => string {
  const { resolve } = require('path');

  return (input: string) => {
    // 绝对路径直接返回（跨平台兼容）
    if (isAbsolute(input)) {
      return input;
    }
    // 相对路径相对于插件根目录
    return resolve(pluginRoot, input);
  };
}

/**
 * 创建不支持 API 的错误抛出器
 */
function createUnsupportedApiCaller(apiName: string, diagnosticsCallback?: () => void): never {
  diagnosticsCallback?.();
  throw new Error(
    `[OpenClaw Compat] '${apiName}' is not supported in AgentDev.\n` +
    `Supported APIs: registerTool, on(before_tool_call), on(after_tool_call)\n` +
    `Unsupported APIs: registerChannel, registerGatewayMethod, registerHttpRoute, registerCli, registerService, registerProvider`
  );
}

/**
 * 创建兼容运行时
 */
export function createCompatRuntime(
  agentId: string,
  toolInvoker: (name: string, params: unknown) => Promise<unknown>
): AgentDevOpenClawCompatRuntime {
  return {
    tools: {
      invoke: toolInvoker,
    },
    logging: {
      getChildLogger: (bindings?: Record<string, unknown>) =>
        createChildLogger(createPluginLogger(agentId), bindings),
    },
    state: {
      agentId,
    },
  };
}

/**
 * 创建兼容 API
 *
 * @param pluginId 插件 ID
 * @param pluginRoot 插件根目录
 * @param agentConfig Agent 配置
 * @param toolRegistry 工具注册函数
 * @param hookRegistry 钩子注册函数
 * @returns 兼容 API
 */
export function createCompatApi(
  pluginId: string,
  pluginRoot: string,
  agentConfig: Record<string, unknown>,
  pluginConfig: Record<string, unknown> | undefined,
  toolRegistry: (tool: Tool) => void,
  hookRegistry: <K extends CompatHookName>(
    hookName: K,
    handler: CompatHookHandlerMap[K],
    priority: number
  ) => void,
  toolInvoker: (name: string, params: unknown) => Promise<unknown>,
  __diagnostics?: { unsupportedApi?: (apiName: string) => void }
): AgentDevOpenClawCompatApi {
  const logger = createPluginLogger(pluginId);
  const runtime = createCompatRuntime(pluginId, toolInvoker);
  const resolvePath = createPathResolver(pluginRoot);

  return {
    id: pluginId,
    name: pluginId,
    source: pluginRoot,
    config: agentConfig as any,
    pluginConfig,
    logger,
    runtime,

    // 支持的 API
    registerTool: (toolOrFactory, opts?) => {
      const tool = typeof toolOrFactory === 'function'
        ? toolOrFactory({ /* api reference if needed */ } as AgentDevOpenClawCompatApi)
        : toolOrFactory;

      // 转换为 AgentDev Tool 格式
      const agentDevTool: Tool = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (args) => {
          // 创建兼容上下文
          const compatContext = {
            messages: [], // 会在执行时填充
            call: { id: '', name: tool.name, arguments: args } as any,
          };
          return tool.execute({ args, context: compatContext });
        },
      };

      // 可选工具：如果 opts.optional 为 true，注册失败不抛错
      try {
        toolRegistry(agentDevTool);
        logger.debug(`Registered tool: ${tool.name}`);
      } catch (error) {
        if (opts?.optional) {
          logger.warn(`Optional tool registration failed: ${tool.name}`);
        } else {
          throw error;
        }
      }
    },

    on: (hookName, handler, opts?) => {
      const priority = opts?.priority ?? 0;
      hookRegistry(hookName, handler, priority);
      logger.debug(`Registered hook: ${hookName} (priority: ${priority})`);
    },

    resolvePath,

    // 不支持的 API（调用时抛出错误）
    get registerChannel(): never {
      return createUnsupportedApiCaller('registerChannel', () => __diagnostics?.unsupportedApi?.('registerChannel'));
    },
    get registerGatewayMethod(): never {
      return createUnsupportedApiCaller('registerGatewayMethod', () => __diagnostics?.unsupportedApi?.('registerGatewayMethod'));
    },
    get registerHttpRoute(): never {
      return createUnsupportedApiCaller('registerHttpRoute', () => __diagnostics?.unsupportedApi?.('registerHttpRoute'));
    },
    get registerCli(): never {
      return createUnsupportedApiCaller('registerCli', () => __diagnostics?.unsupportedApi?.('registerCli'));
    },
    get registerService(): never {
      return createUnsupportedApiCaller('registerService', () => __diagnostics?.unsupportedApi?.('registerService'));
    },
    get registerProvider(): never {
      return createUnsupportedApiCaller('registerProvider', () => __diagnostics?.unsupportedApi?.('registerProvider'));
    },
  };
}
