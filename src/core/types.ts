/**
 * 基础类型定义
 * 所有类型集中在这里，简单直观
 */

// 消息角色
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// 消息结构
export interface Message {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoning?: string; // 思考内容（GLM-4.7等模型的扩展字段）
}

// 工具调用
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

// LLM 响应
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: string; // 思考内容（GLM-4.7等模型的扩展字段）
}

// 工具渲染配置
export interface ToolRenderConfig {
  /** 调用时的渲染模板名称 */
  call?: string;
  /** 结果时的渲染模板名称 */
  result?: string;
}

// 工具定义
export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, any>;
  execute: (args: any) => Promise<any>;
  /** 可选：渲染配置 */
  render?: ToolRenderConfig;
}

// LLM 接口 - 所有 LLM 适配器都需要实现这个
export interface LLMClient {
  chat(messages: Message[], tools: Tool[]): Promise<LLMResponse>;
}

// 占位符上下文类型
import type { PlaceholderContext, TemplateSource } from '../template/types.js';

// Agent 配置
export interface AgentConfig {
  llm: LLMClient;
  tools?: Tool[];
  maxTurns?: number;
  systemMessage?: string | TemplateSource;
  name?: string;  // Agent 显示名称（用于调试）
  skillsDir?: string;  // Skills 目录路径
}

// 上下文中间件 - 用于处理消息数组
export type ContextMiddleware = (messages: Message[]) => Message[];

// ============= 多 Agent 调试支持 =============

/**
 * Agent 注册信息（Hub 端）
 */
export interface AgentInfo {
  id: string;           // 唯一标识，如 "agent-1"
  name: string;         // 显示名称
  registeredAt: number; // 注册时间戳
}

/**
 * 工具元数据（用于前端渲染）
 */
export interface ToolMetadata {
  name: string;
  description: string;
  render: {
    call: string;   // 模板名称
    result: string; // 模板名称
  };
}

/**
 * Agent 会话数据（Worker 端）
 */
export interface AgentSession {
  id: string;
  name: string;
  messages: Message[];
  tools: ToolMetadata[];
  createdAt: number;
  lastActive: number;
}

/**
 * DebugHub IPC 消息类型（主进程 → Worker）
 * 使用 discriminated union 确保类型安全
 */
export type DebugHubIPCMessage =
  | RegisterAgentMsg
  | PushMessagesMsg
  | RegisterToolsMsg
  | SetCurrentAgentMsg
  | UnregisterAgentMsg
  | StopMsg;

/**
 * 注册新 Agent
 */
export interface RegisterAgentMsg {
  type: 'register-agent';
  agentId: string;
  name: string;
  createdAt: number;
}

/**
 * 推送 Agent 消息
 */
export interface PushMessagesMsg {
  type: 'push-messages';
  agentId: string;
  messages: Message[];
}

/**
 * 注册 Agent 工具
 */
export interface RegisterToolsMsg {
  type: 'register-tools';
  agentId: string;
  tools: Tool[];
}

/**
 * 切换当前选中的 Agent
 */
export interface SetCurrentAgentMsg {
  type: 'set-current-agent';
  agentId: string;
}

/**
 * 注销 Agent
 */
export interface UnregisterAgentMsg {
  type: 'unregister-agent';
  agentId: string;
}

/**
 * 停止 Worker
 */
export interface StopMsg {
  type: 'stop';
}

/**
 * Worker → 主进程 消息
 */
export type WorkerIPCMessage =
  | ReadyMsg
  | AgentSwitchedMsg;

/**
 * Worker 就绪
 */
export interface ReadyMsg {
  type: 'ready';
}

/**
 * Agent 切换确认
 */
export interface AgentSwitchedMsg {
  type: 'agent-switched';
  agentId: string;
}
