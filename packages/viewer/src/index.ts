/**
 * @agentdevjs/viewer - 调试查看器
 *
 * ViewerWorker：独立进程 HTTP + UDS 服务器，承载 Web UI 与只读调试 MCP。
 *
 * DebugHub 与 IPC 协议类型在 @agentdevjs/core（logging 契约直接依赖 DebugHub 类）。
 */

export { ViewerWorker } from './viewer-worker.js';
export {
  DebuggerMCPServer,
  DEBUGGER_MCP_PROMPT_DEFINITIONS,
  DEBUGGER_MCP_RESOURCE_DEFINITIONS,
  DEBUGGER_MCP_TOOL_DEFINITIONS,
  createDebuggerAgentDetails,
  createDebuggerAgentSummary,
  filterDebuggerLogs,
} from './debugger-mcp.js';
export type { DebuggerLogQuery, DebuggerAgentSummary, DebuggerAgentDetails } from './debugger-mcp.js';
export { generateViewerHtml } from './viewer-html/index.js';
