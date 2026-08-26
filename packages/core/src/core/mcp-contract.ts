/**
 * MCP 契约类型（协议中性，零运行时依赖）
 *
 * AgentConfig.mcp 等框架核心契约依赖这些配置形状，因此它们留在 @agentdevjs/core。
 * MCP 集成实现（连接管理 / 工具挂载 / MCPFeature）在 @agentdevjs/mcp 包，
 * 并从这里 re-export 契约类型以保持单一权威定义。
 */

/**
 * MCP 传输层类型
 */
export type MCPTransportType = 'stdio' | 'http' | 'sse';

/**
 * MCP stdio 传输配置
 */
export interface MCPSstdioConfig {
  /** 传输类型 */
  transport: 'stdio';
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args: string[];
  /** 环境变量 (可选) */
  env?: Record<string, string>;
  /** 工作目录 (可选) */
  cwd?: string;
}

/**
 * MCP HTTP 传输配置
 */
export interface MCPHTTPConfig {
  /** 传输类型 */
  transport: 'http';
  /** 服务器 URL */
  url: string;
  /** HTTP 请求头 (可选) */
  headers?: Record<string, string>;
  /** 超时时间 (毫秒，默认 30000) */
  timeout?: number;
  /** 重连次数 (默认 3) */
  retryCount?: number;
}

/**
 * MCP SSE 传输配置
 */
export interface MCPSSEConfig {
  /** 传输类型 */
  transport: 'sse';
  /** 服务器 URL */
  url: string;
  /** HTTP 请求头 (可选) */
  headers?: Record<string, string>;
  /** 重连次数 (默认 3) */
  retryCount?: number;
}

/**
 * MCP 服务器配置
 */
export type MCPServerConfig =
  | MCPSstdioConfig
  | MCPHTTPConfig
  | MCPSSEConfig;

/**
 * MCP 工具映射配置
 */
export interface MCPToolMappingConfig {
  /** 渲染模板覆盖 */
  render?: {
    call?: string;
    result?: string;
  };
  /** 工具注解覆盖 */
  annotations?: {
    /** 是否需要用户批准 */
    requiresApproval?: boolean;
    /** 是否为只读工具 */
    readOnly?: boolean;
    /** 是否为破坏性操作 */
    destructive?: boolean;
  };
  /** 是否禁用该工具 */
  disabled?: boolean;
}

/**
 * MCP 主配置
 */
export interface MCPConfig {
  /** 是否启用 MCP (默认 true) */
  enabled?: boolean;
  /** MCP 服务器配置 */
  servers: Record<string, MCPServerConfig>;
  /** 旧格式兼容 */
  mcpServers?: Record<string, MCPServerConfig>;
  /** 工具级别配置映射 */
  toolMapping?: Record<string, MCPToolMappingConfig>;
  /** 全局超时 (毫秒) */
  timeout?: number;
  /** 是否启用工具缓存 */
  enableCache?: boolean;
}
