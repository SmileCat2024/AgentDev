/**
 * HTTP 客户端基础设施
 *
 * 复用 Claude Code 同款解决方式：
 * - 不手动覆写 dns.lookup，利用 undici 内置 DNS 缓存和连接池
 * - 使用 EnvHttpProxyAgent 自动处理 HTTPS_PROXY / NO_PROXY
 * - 通过 setGlobalDispatcher 全局设置（对原生 fetch 立即生效）
 *
 * 两种 fetch 的集成方式：
 * 1. 原生 fetch()（Anthropic 适配器） → setGlobalDispatcher 全局生效
 * 2. OpenAI SDK 的 node-fetch → 自带 agentkeepalive，无需额外处理
 */

import { createLogger } from '../core/logging.js';

const logger = createLogger('llm.http-client');

// 动态加载 undici（兼容打包和运行时）
let undici: any;
let undiciLoadPromise: Promise<any> | null = null;
let initialGlobalDispatcher: any = null;

export const HTTP_CONNECT_TIMEOUT_MS = 10_000;
export const HTTP_HEADERS_TIMEOUT_MS = 60_000;

export function buildHttpDispatcherOptions(noProxy?: string): Record<string, unknown> {
  return {
    ...(noProxy ? { noProxy } : {}),
    headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
    connect: { timeout: HTTP_CONNECT_TIMEOUT_MS },
  };
}

export function isExternallyManagedDispatcher(current: any, initial: any): boolean {
  return current != null && initial != null && current !== initial;
}

async function loadUndici(): Promise<any> {
  if (undiciLoadPromise) {
    return undiciLoadPromise;
  }

  undiciLoadPromise = (async () => {
    // 方法1: 尝试直接 ESM 导入 undici
    try {
      const mod = await import('undici');
      return mod;
    } catch {
      // 方法2: 使用 createRequire
      try {
        const { createRequire } = await import('module');
        const _require = createRequire(import.meta.url);
        return _require('undici');
      } catch {
        logger.warn('Failed to load undici, proxy and DNS caching will not be available');
        return null;
      }
    }
  })();

  return undiciLoadPromise;
}

// 初始化 undici 加载
undici = await loadUndici();
initialGlobalDispatcher = undici?.getGlobalDispatcher?.() ?? null;

// ========== 代理配置 ==========

/**
 * 检测代理 URL
 *
 * 优先级：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy
 */
function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  );
}

/**
 * 遮蔽代理 URL 中的密码
 */
function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

// ========== Undici 全局调度器 ==========

let httpClientInitialized = false;
let _dispatcher: any = null;

/**
 * 获取当前的 undici Dispatcher
 */
export function getGlobalDispatcher(): any {
  return _dispatcher;
}

/**
 * 初始化 HTTP 客户端
 *
 * 设置 Undici 全局调度器（同步完成）：
 * - 有代理 → EnvHttpProxyAgent（自动处理 NO_PROXY）
 * - 无代理 → Agent（keep-alive + 连接池，内置 DNS 缓存）
 *
 * 此函数幂等，多次调用无副作用。
 */
export async function initHttpClient(): Promise<void> {
  if (httpClientInitialized) return;
  httpClientInitialized = true;

  // 确保 undici 已加载
  if (!undici) {
    undici = await loadUndici();
    if (!undici) {
      logger.warn('undici not available, skipping HTTP client initialization');
      return;
    }
  }

  const proxyUrl = getProxyUrl();

  try {
    // An embedding host may already own the global dispatcher (for example,
    // AgentDevClaw applies a runtime-switchable proxy before starting agents).
    // Replacing it here creates two competing proxy lifecycles and discards
    // the host's timeout/NO_PROXY policy. Reuse the host-owned dispatcher.
    const currentDispatcher = undici.getGlobalDispatcher?.() ?? null;
    if (isExternallyManagedDispatcher(currentDispatcher, initialGlobalDispatcher)) {
      _dispatcher = currentDispatcher;
      logger.info('Using host-managed Undici dispatcher');
      return;
    }

    // undici 已作为外部依赖导入，运行时由 Node.js 提供

    if (proxyUrl) {
      // EnvHttpProxyAgent 自动尊重 NO_PROXY / no_proxy 环境变量
      const proxyAgent = new undici.EnvHttpProxyAgent({
        httpProxy: proxyUrl,
        httpsProxy: proxyUrl,
        ...buildHttpDispatcherOptions(process.env.NO_PROXY || process.env.no_proxy),
      });
      undici.setGlobalDispatcher(proxyAgent);
      _dispatcher = proxyAgent;
      logger.info('Proxy Agent configured (EnvHttpProxyAgent)', {
        proxy: maskProxyUrl(proxyUrl),
      });
    } else {
      // 默认 Agent：keep-alive + 连接池
      // undici Agent 内置 DNS 缓存（通过 Node.js 内部的 c-ares 解析器）
      const agent = new undici.Agent({
        ...buildHttpDispatcherOptions(),
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 300_000,
        connections: 50,
        pipelining: 1,
      });
      undici.setGlobalDispatcher(agent);
      _dispatcher = agent;
      logger.debug('Undici Agent configured (default, with keep-alive)');
    }
  } catch (e: any) {
    logger.warn('Failed to set up undici dispatcher, proxy env vars will be ignored', {
      error: e.message || String(e),
    });
  }
}
