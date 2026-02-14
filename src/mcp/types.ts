/**
 * MCP 集成类型定义
 *
 * 定义 MCP 服务器配置、连接管理和工具发现的类型
 */

/**
 * MCP 传输层类型
 */
export type MCPTransportType = 'stdio' | 'http';

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
 * MCP 服务器配置
 */
export type MCPServerConfig =
  | MCPSstdioConfig
  | MCPHTTPConfig;

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
  /** 工具级别配置映射 */
  toolMapping?: Record<string, MCPToolMappingConfig>;
  /** 全局超时 (毫秒) */
  timeout?: number;
  /** 是否启用工具缓存 */
  enableCache?: boolean;
}

/**
 * MCP 连接状态
 */
export const enum MCPConnectionState {
  /** 未连接 */
  Disconnected = 'disconnected',
  /** 连接中 */
  Connecting = 'connecting',
  /** 已连接 */
  Connected = 'connected',
  /** 连接错误 */
  Error = 'error',
}

/**
 * MCP 连接信息
 */
export interface MCPConnectionInfo {
  /** 服务器名称 */
  name: string;
  /** 连接状态 */
  state: MCPConnectionState;
  /** 连接时间 */
  connectedAt?: number;
  /** 最后错误 */
  lastError?: string;
  /** 工具数量 */
  toolCount: number;
}

/**
 * MCP 工具调用结果
 */
export interface MCPToolResult {
  /** 是否成功 */
  success: boolean;
  /** 结果内容 */
  content?: string;
  /** 结构化数据 (如果可用) */
  structuredContent?: any;
  /** 错误信息 */
  error?: string;
  /** MCP 服务器名称 */
  server: string;
  /** 调用耗时 (毫秒) */
  duration: number;
  /** 图像数据 (如果有) */
  images?: Array<{
    data: string;
    mimeType: string;
  }>;
  /** 资源数据 (如果有) */
  resources?: Array<{
    uri: string;
    mimeType: string;
    text?: string;
  }>;
}

/**
 * MCP 统计信息
 */
export interface MCPStatistics {
  /** 总调用次数 */
  totalCalls: number;
  /** 成功调用次数 */
  successfulCalls: number;
  /** 失败调用次数 */
  failedCalls: number;
  /** 平均耗时 (毫秒) */
  averageDuration: number;
  /** 按服务器统计 */
  byServer: Record<string, {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    averageDuration: number;
  }>;
}

/**
 * MCP 客户端配置
 */
export interface MCPClientConfig {
  /** 配置文件路径 */
  configPath?: string;
  /** 是否自动重连 */
  autoReconnect?: boolean;
  /** 重连间隔 (毫秒) */
  reconnectInterval?: number;
  /** 最大重连次数 */
  maxReconnectAttempts?: number;
  /** 日志级别 */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}
