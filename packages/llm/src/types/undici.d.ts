/**
 * Undici 类型声明
 *
 * Undici 是 Node.js 内置模块，自带类型定义。
 * 这个文件用于确保 TypeScript 编译器能正确识别。
 */

declare module 'undici' {
  export interface AgentOptions {
    keepAliveTimeout?: number;
    keepAliveMaxTimeout?: number;
    connections?: number;
    pipelining?: number;
  }

  export class Agent {
    constructor(options?: AgentOptions);
  }

  export interface EnvHttpProxyAgentOptions {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
  }

  export class EnvHttpProxyAgent {
    constructor(options: EnvHttpProxyAgentOptions);
  }

  export function setGlobalDispatcher(dispatcher: Agent | EnvHttpProxyAgent): void;
  export function getGlobalDispatcher(): Agent | EnvHttpProxyAgent;
}
