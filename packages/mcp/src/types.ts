/**
 * MCP 集成类型定义
 *
 * 契约类型（服务器配置形状）的权威定义在 @agentdevjs/core（core/mcp-contract），
 * 此处 re-export 保持旧导入路径兼容；连接管理与调用的运行时类型定义在本包。
 */

// 契约类型：权威定义在 @agentdevjs/core
export type {
  MCPTransportType,
  MCPServerConfig,
  MCPSstdioConfig,
  MCPHTTPConfig,
  MCPSSEConfig,
  MCPConfig,
  MCPToolMappingConfig,
} from '@agentdevjs/core';

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
