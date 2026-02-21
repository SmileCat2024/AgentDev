/**
 * 基础类型定义
 * 所有类型集中在这里，简单直观
 */

// ========== 通知系统类型 ==========

/**
 * 通知分类
 * - state: 覆盖式更新（如 LLM 字符计数）
 * - event: 追加式记录（如工具开始/完成）
 */
export type NotificationCategory = 'state' | 'event';

/**
 * LLM 生成阶段
 */
export type LLMPhase = 'thinking' | 'content' | 'tool_calling';

/**
 * 通知基础接口
 */
export interface Notification {
  type: string;
  category: NotificationCategory;
  timestamp: number;
  data: unknown;
}

/**
 * LLM 字符计数通知数据
 */
export interface LLMCharCountData {
  charCount: number;
  phase: LLMPhase;
}

/**
 * LLM 完成通知数据
 */
export interface LLMCompleteData {
  totalChars: number;
}

/**
 * 工具开始通知数据
 */
export interface ToolStartData {
  toolName: string;
}

/**
 * 工具完成通知数据
 */
export interface ToolCompleteData {
  toolName: string;
  success: boolean;
  duration: number;
}

/**
 * 通知状态响应（GET /api/agents/:id/notification）
 */
export interface NotificationStateResponse {
  state: Notification | null;
  hasNewEvents: boolean;
}

// ========== 消息类型 ==========

// 消息角色（支持子代理 ID 作为消息来源）
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | string;

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

// ============= 渲染模板类型 =============
/**
 * 渲染模板项
 * 可以是字符串模板或函数模板
 */
export type RenderTemplateItem =
  | string                    // 字符串模板，使用 {{key}} 插值
  | RenderTemplateFn;         // 函数模板，处理复杂逻辑

/**
 * 渲染模板函数类型
 */
export type RenderTemplateFn = (data: Record<string, any>, success?: boolean) => string;

/**
 * 内联渲染模板
 * 直接定义在工具中的渲染模板（无需引用预设模板）
 */
export interface InlineRenderTemplate {
  call: RenderTemplateItem;
  result: RenderTemplateItem;
}

// 工具渲染配置
export interface ToolRenderConfig {
  /** 调用时的渲染模板（字符串引用或内联模板） */
  call?: string | InlineRenderTemplate;
  /** 结果时的渲染模板（字符串引用或内联模板） */
  result?: string | InlineRenderTemplate;
}

// 工具定义
export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, any>;
  execute: (args: any, context?: any) => Promise<any>;
  /** 可选：渲染配置 */
  render?: ToolRenderConfig;
}

// LLM 接口 - 所有 LLM 适配器都需要实现这个
export interface LLMClient {
  chat(messages: Message[], tools: Tool[]): Promise<LLMResponse>;
}

// 占位符上下文类型
import type { PlaceholderContext, TemplateSource } from '../template/types.js';

// MCP 类型导入
import type { MCPConfig } from '../mcp/types.js';

// Agent 配置
export interface AgentConfig {
  llm: LLMClient;
  tools?: Tool[];
  maxTurns?: number;
  systemMessage?: string | TemplateSource;
  name?: string;  // Agent 显示名称（用于调试）
  skillsDir?: string;  // Skills 目录路径
  /** MCP 配置（可选） */
  mcp?: MCPConfig;
  /** MCP 上下文参数（运行时注入，如用户 Token） */
  mcpContext?: Record<string, unknown>;
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
    call: string | InlineRenderTemplate;   // 模板名称或内联模板
    result: string | InlineRenderTemplate; // 模板名称或内联模板
    // 内联模板的可选直接存储（用于前端特殊标记）
    inlineCall?: InlineRenderTemplate;
    inlineResult?: InlineRenderTemplate;
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
  // 通知系统扩展
  currentState: Notification | null;
  events: Notification[];
  lastEventCount: number;
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
  | PushNotificationMsg
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
 * 推送通知
 */
export interface PushNotificationMsg {
  type: 'push-notification';
  agentId: string;
  notification: Notification;
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

// ========== 生命周期类型 re-export ==========
// 生命周期类型从 lifecycle.ts 导出，保持类型定义集中管理
export type {
  AgentInitiateContext,
  AgentDestroyContext,
  CallStartContext,
  CallFinishContext,
  TurnStartContext,
  TurnFinishedContext,
  LLMStartContext,
  LLMFinishContext,
  HookResult,
  ToolContext,
  ToolResult,
} from './lifecycle.js';
