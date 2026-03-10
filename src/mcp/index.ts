/**
 * MCP 集成模块
 *
 * 提供 MCP 服务器连接、工具适配和渲染功能
 */

// 类型定义
export type {
  MCPServerConfig,
  MCPSstdioConfig,
  MCPHTTPConfig,
  MCPSSEConfig,
  MCPConfig,
  MCPConnectionInfo,
  MCPToolResult,
  MCPStatistics,
  MCPClientConfig,
} from './types.js';

// 导出枚举作为值
export { MCPConnectionState } from './types.js';

// 连接管理
export { MCPConnectionManager } from './connection-manager.js';
export {
  MCPClient,
  createMCPTool,
  createMCPToolsFromClient,
  discoverMCPTools,
  createDefaultMCPToolName,
  type MCPDiscoveredTool,
  type MCPDiscoveredToolSet,
  type MCPToolCreationOptions,
  type MCPToolDiscoveryOptions,
} from './client.js';
export {
  getDefaultMCPConfigDir,
  loadAllMCPConfigs,
  loadMCPConfigFromInput,
} from './config.js';

// 工具适配
export {
  MCPToolAdapter,
  createMCPToolAdapters,
  type MCPToolAdapterConfig,
} from './mcp-adapter.js';

// 渲染
export {
  MCP_RENDER_TEMPLATES,
  getMCPRenderTemplate,
  renderMCPToolCall,
  renderMCPToolResult,
} from './render.js';
