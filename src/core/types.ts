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

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type DebugLogDeliveryReason =
  | 'hub'
  | 'hub-unavailable'
  | 'no-agent-context';

export interface DebugLogDelivery {
  hub: boolean;
  console: boolean;
  reason: DebugLogDeliveryReason;
}

export interface LogContextRef {
  agentId?: string;
  agentName?: string;
  parentAgentId?: string;
  callIndex?: number;
  step?: number;
  toolName?: string;
  toolCallId?: string;
  feature?: string;
  lifecycle?: string;
  hookMethod?: string;
  hookKind?: 'forward' | 'reverse';
  sourceFile?: string;
  sourceLine?: number;
  tags?: string[];
  [key: string]: unknown;
}

export interface DebugLogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  namespace: string;
  context: LogContextRef;
  data?: unknown;
  delivery: DebugLogDelivery;
}

/**
 * LLM 字符计数通知数据
 */
export interface LLMCharCountData {
  charCount: number;
  phase: LLMPhase;
  thinkingChars?: number;
  contentChars?: number;
  toolCallCount?: number;
}

/**
 * LLM 完成通知数据
 */
export interface LLMCompleteData {
  totalChars: number;
}

export interface ToolStartData {
  toolName: string;
}

export type RuntimeStage =
  | 'idle'
  | 'llm_thinking'
  | 'llm_content'
  | 'llm_tool_call_building'
  | 'awaiting_runtime'
  | 'tool_executing'
  | 'retry_waiting'
  | 'retry_requesting'
  | 'completed'
  | 'failed';

export interface AgentRuntimeSnapshot {
  stage: RuntimeStage;
  callActive: boolean;
  charCount: number;
  thinkingChars: number;
  contentChars: number;
  toolCallCount: number;
  activeToolNames: string[];
  activeToolCount: number;
  callStartedAt?: number;
  stageStartedAt?: number;
  retryAttempt?: number;
  maxRetries?: number;
  nextRetryDelayMs?: number;
  lastErrorType?: string | null;
  lastErrorMessage?: string | null;
  updatedAt: number;
}

/**
 * 工具定义
 */
export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, any>;
  /**
   * 执行工具
   *
   * @param args 工具参数
   * @param context 执行上下文，可能包含：
   *   - signal?: AbortSignal - 用于中断工具执行
   *   - ...其他上下文信息
   */
  execute: (args: any, context?: any) => Promise<any>;
  /** 可选：渲染配置 */
  render?: ToolRenderConfig;
  /**
   * 工具执行模式
   * - 'normal'（默认）：普通工具，可与其他工具在同一次 assistant turn 中并行调用
   * - 'exclusive'：独占工具，必须是 assistant turn 中唯一的工具调用
   *
   * exclusive 工具适用于控制流工具（如 checkpoint、rollback），
   * 它们不应与其他工具产生副作用交织。
   */
  executionMode?: 'normal' | 'exclusive';
  /**
   * 工具是否可并行执行。
   *
   * - true: 该工具可以与同批次中其他 parallelizable 工具并发执行
   * - false/undefined: 串行执行（默认，向后兼容）
   *
   * 约束：
   * - exclusive 工具忽略此属性（exclusive 总是独占批次）
   * - 标记为 parallelizable 的工具应是无副作用的只读操作，
   *   或其副作用不会与同批次其他工具冲突
   */
  parallelizable?: boolean;
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
  event: Notification | null;
  runtime: AgentRuntimeSnapshot;
  callActive: boolean;
  hasNewEvents: boolean;
}

export interface AgentLogsResponse {
  scope: 'current' | 'all';
  currentAgentId: string | null;
  selectedAgentId: string | null;
  total: number;
  logs: DebugLogEntry[];
  truncation?: {
    truncated: boolean;
    appliedLimit?: number;
    returnedCount: number;
    availableCount: number;
    nextOffset?: number;
    reason?: string;
    guidance?: string;
  };
  collectionPolicy: {
    hubConnected: boolean;
    includesOnlyHubDeliveredLogs: boolean;
    fallbackBehavior: string;
  };
}

/**
 * Agent 连接状态响应（GET /api/agents/:id/connection）
 */
export interface AgentConnectionResponse {
  connected: boolean;
}

// ========== 消息类型 ==========

// 消息角色（支持子代理 ID 作为消息来源）
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | string;

// 消息结构
export interface Message {
  role: MessageRole;
  content: string;
  turn?: number;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoning?: string; // 思考内容（GLM-4.7等模型的扩展字段）
  thinkingBlocks?: ThinkingBlock[];
  /**
   * LLM 用量信息（仅 assistant 消息有值）。
   *
   * 由 LLM provider 在生成响应时返回，表示生成此消息时的上下文 token 开销。
   * inputTokens 是发送给 LLM 的完整上下文大小（包含所有历史消息），
   * 不是单条消息的 token 数。
   */
  usage?: MessageUsage;
}

/**
 * 消息级用量记录（盖戳在 assistant 消息上）
 */
export interface MessageUsage {
  /** 生成此消息时，发送给 LLM 的总输入 token（即当时的完整上下文大小） */
  inputTokens: number;
  /** LLM 生成的输出 token */
  outputTokens: number;
}

export interface ThinkingBlock {
  signature: string;
  thinking: string;
}

// 工具调用
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * 统一用量格式（兼容 Anthropic 和 OpenAI）
 */
export interface UsageInfo {
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 总 token 数 */
  totalTokens: number;

  // ========== Anthropic 特有（可选）==========
  /** 创建缓存消耗的 token 数 */
  cacheCreationTokens?: number;
  /** 从缓存读取的 token 数 */
  cacheReadTokens?: number;

  // ========== OpenAI 特有（可选）==========
  /** 推理 token 数 */
  reasoningTokens?: number;
  /** 音频 token 数 */
  audioTokens?: number;
}

// LLM 响应
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: string; // 思考内容（GLM-4.7等模型的扩展字段）
  thinkingBlocks?: ThinkingBlock[];
  /** 用量统计（可选） */
  usage?: UsageInfo;
  /** 停止原因，由 LLM API 返回（如 end_turn, tool_use, stop 等） */
  stopReason?: string | null;
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

// LLM 接口 - 所有 LLM 适配器都需要实现这个
export interface LLMClient {
  chat(messages: Message[], tools: Tool[], options?: LLMChatOptions): Promise<LLMResponse>;
  /** 可选：返回当前 LLM 实例使用的模型名（用于调试显示） */
  readonly modelName?: string;
}

// LLM 调用选项
export interface LLMChatOptions {
  /** 允许中断正在进行的 LLM 调用 */
  signal?: AbortSignal;
}

// 占位符上下文类型
import type { PlaceholderContext, TemplateSource } from '../template/types.js';

// MCP 类型导入
import type { MCPConfig } from '../mcp/types.js';
import type { UsageStatsSnapshot } from './usage.js';

// Agent 配置
export interface AgentConfig {
  llm: LLMClient;
  tools?: Tool[];
  maxTurns?: number;
  systemMessage?: string | TemplateSource;
  name?: string;  // Agent 显示名称（用于调试）
  projectRoot?: string;
  workspaceDir?: string;

  // ========== Feature 系统 ==========
  /**
   * Feature 配置
   *
   * 新的声明式 Feature 注册方式
   */
  features?: {
    /** 启用的 Feature 列表 */
    enabled?: string[];
    /** Feature 特定配置 */
    [key: string]: unknown;
  };
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
  projectRoot?: string;
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

export interface HookSourceLocation {
  file?: string;
  line?: number;
  column?: number;
  display: string;
}

export interface HookEntryMetadata {
  order: number;
  featureName: string;
  methodName: string;
  lifecycle: string;
  kind: 'decision' | 'notify';
  source?: HookSourceLocation;
  description?: string;
}

export interface HookLifecycleSnapshot {
  lifecycle: string;
  kind: 'decision' | 'notify';
  entries: HookEntryMetadata[];
}

export interface FeatureInspectorSnapshot {
  name: string;
  enabled: boolean;
  status: 'enabled' | 'disabled' | 'removed' | 'partial';
  hookCount: number;
  toolCount: number;
  enabledToolCount: number;
  source?: string;
  description?: string;
  tools: Array<{
    name: string;
    description: string;
    state: 'enabled' | 'disabled' | 'removed' | 'superseded';
    enabled?: boolean;
    renderCall?: string;
    renderResult?: string;
  }>;
}

export interface HookInspectorSnapshot {
  lifecycleOrder: string[];
  features: FeatureInspectorSnapshot[];
  hooks: HookLifecycleSnapshot[];
  standaloneTools?: Array<{
    name: string;
    description: string;
    state: 'enabled' | 'disabled' | 'removed' | 'superseded';
    enabled?: boolean;
    source?: string;
    renderCall?: string;
    renderResult?: string;
  }>;
}

export interface AgentContextMetrics {
  messageCount: number;
  charCount: number;
  toolCallCount: number;
  turnCount: number;
}

export interface AgentOverviewSnapshot {
  updatedAt: number;
  context: AgentContextMetrics;
  usageStats: UsageStatsSnapshot;
  runtime?: AgentRuntimeSnapshot;
  /** 可选：当前使用的模型名（由 agent 实例注入） */
  modelName?: string;
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
  // 项目根目录（用于定位模板文件）
  projectRoot?: string;
  // 通知系统扩展
  currentState: Notification | null;
  // call 运行状态（独立于 currentState，不受 state 覆盖影响）
  callActive?: boolean;
  runtimeState?: AgentRuntimeSnapshot;
  events: Notification[];
  lastEventCount: number;
  logs: DebugLogEntry[];
  // 所属 UDS 客户端连接 ID（用于多进程输入响应路由）
  clientId?: string;
  // 内部：上次最后一条消息的签名（用于推送去重）
  _lastMessageSig?: string;
  hookInspector?: HookInspectorSnapshot;
  overview?: AgentOverviewSnapshot;
  // 运行期间排队等待的用户输入（用于输入框常驻 + 队列注入）
  queuedInputs: QueuedInput[];
}

/**
 * 排队的用户输入
 */
export interface QueuedInput {
  id: string;
  text: string;
  timestamp: number;
}

/**
 * DebugHub IPC 消息类型（主进程 → Worker）
 * 使用 discriminated union 确保类型安全
 */
export type DebugHubIPCMessage =
  | RegisterAgentMsg
  | UpdateAgentInspectorMsg
  | UpdateAgentOverviewMsg
  | PushMessagesMsg
  | RegisterToolsMsg
  | SetCurrentAgentMsg
  | UnregisterAgentMsg
  | PushNotificationMsg
  | RequestInputMsg
  | QueueInputMsg
  | ConsumeQueuedInputMsg
  | InterruptAgentMsg
  | StopMsg;

/**
 * 注册新 Agent
 */
export interface RegisterAgentMsg {
  type: 'register-agent';
  agentId: string;
  name: string;
  createdAt: number;
  projectRoot?: string; // 项目根目录，用于模板文件加载
  featureTemplates?: Record<string, string>; // Feature 模板路径映射
  hookInspector?: HookInspectorSnapshot;
  overview?: AgentOverviewSnapshot;
  activeInputRequest?: ActiveInputRequest; // 活跃的输入请求（用于重连后恢复）
}

export interface UpdateAgentInspectorMsg {
  type: 'update-agent-inspector';
  agentId: string;
  hookInspector: HookInspectorSnapshot;
}

export interface UpdateAgentOverviewMsg {
  type: 'update-agent-overview';
  agentId: string;
  overview: AgentOverviewSnapshot;
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
 * 活跃的输入请求（用于重连后恢复）
 */
export interface ActiveInputRequest {
  requestId: string;
  prompt: string;
  placeholder?: string;
  initialValue?: string;
  actions?: UserInputAction[];
  timestamp: number;
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
 * 请求用户输入
 */
export interface RequestInputMsg {
  type: 'request-input';
  agentId: string;
  requestId: string;
  prompt: string;
  timeout?: number;
  placeholder?: string;
  initialValue?: string;
  actions?: UserInputAction[];
  mode?: UserInputRequestMode;
  questions?: UserInputQuestion[];
}

/**
 * 排队用户输入（运行期间提交的消息）
 */
export interface QueueInputMsg {
  type: 'queue-input';
  agentId: string;
  input: QueuedInput;
}

/**
 * 通知 Worker 移除一条已被运行时接管/开始处理的排队输入
 */
export interface ConsumeQueuedInputMsg {
  type: 'consume-queued-input';
  agentId: string;
  inputId: string;
}

/**
 * 中断正在运行的 Agent
 */
export interface InterruptAgentMsg {
  type: 'interrupt-agent';
  agentId: string;
  clearQueue?: boolean;
}

/**
 * 用户输入响应（Worker → Agent，通过 UDS）
 */
export interface InputResponseMsg {
  type: 'input-response';
  agentId: string;
  requestId: string;
  input: string;
  response?: UserInputResponse;
}

export interface UserInputAction {
  id: string;
  label: string;
  kind?: 'rollback' | 'custom';
  variant?: 'primary' | 'secondary' | 'danger';
  payload?: Record<string, unknown>;
}

export type UserInputRequestMode = 'text' | 'choices';

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
  /** Whether this option allows supplementary free-text input */
  allowSupplement?: boolean;
  /** Whether the supplement text is required (only meaningful when allowSupplement is true) */
  supplementRequired?: boolean;
  /** Label shown above the supplement textarea */
  supplementLabel?: string;
  /** Placeholder for the supplement textarea */
  supplementPlaceholder?: string;
}

export interface UserInputQuestion {
  id: string;
  question: string;
  options: UserInputOption[];
  allowCustom?: boolean;
  customLabel?: string;
  customPlaceholder?: string;
}

export interface UserInputRequest {
  prompt: string;
  placeholder?: string;
  initialValue?: string;
  actions?: UserInputAction[];
  mode?: UserInputRequestMode;
  questions?: UserInputQuestion[];
}

export interface UserInputChoiceAnswer {
  questionId: string;
  optionId?: string;
  customText?: string;
  /** Supplementary free-text provided alongside the selected option */
  supplementText?: string;
}

export interface UserInputResponse {
  kind: 'text' | 'action' | 'choices';
  text?: string;
  actionId?: string;
  choices?: UserInputChoiceAnswer[];
  payload?: Record<string, unknown>;
}

/**
 * Worker → 主进程 消息
 */
export type WorkerIPCMessage =
  | ReadyMsg
  | AgentSwitchedMsg
  | InputResponseMsg;

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

// ========== 上下文管理类型 ==========
/**
 * 消息标签枚举
 *
 * 用于快速分类和过滤消息，一条消息可能有多个标签
 */
export type MessageTag =
  | 'user'           // 用户输入消息
  | 'system'         // 系统消息
  | 'assistant'      // LLM 响应消息
  | 'tool-call'      // assistant 消息且包含 toolCalls
  | 'tool-result'    // role === 'tool' 的工具执行结果
  | 'sub-agent'      // 来自子代理的消息（与 assistant/tool-result 组合使用）
  | 'reminder';      // Feature 注入的提醒消息（与 system 组合使用）

/**
 * 解析结果结构
 *
 * 从消息 content 中提取的结构化信息
 */
export interface ParsedContent {
  /** 从 content 提取的任务 ID（正则匹配 "taskId":"xxx"） */
  taskIds: string[];
  /** 从 content 提取的工具调用名称（从 toolCalls 或 content 解析） */
  toolCalls: string[];
  /** @ 提及的内容 */
  mentions: string[];
  /** 用户可继承扩展更多字段 */
  [key: string]: any;
}

/**
 * 消息元数据
 *
 * 用于 addMessage() 的元数据参数
 */
export interface MessageMeta {
  /** ReAct 循环轮次 */
  turn: number;
  /** 子代理 ID（子代理消息时填写） */
  agentId?: string;
  /** 来源 Feature（reminder 等消息时填写） */
  source?: string;
}

/**
 * 扩展的消息结构
 *
 * 在原始 Message 基础上添加元数据
 * 不破坏现有 Message 类型，保证 LLM 调用兼容性
 */
export interface EnrichedMessage extends Message {
  // === 元数据字段 ===

  /** 唯一标识（用于索引关联） */
  id: string;
  /** 消息产生时间戳（毫秒） */
  timestamp: number;
  /** 所属 ReAct 循环轮次（从 0 开始） */
  turn: number;
  /** 全局消息序号（从 0 开始递增） */
  sequence: number;
  /** 来源 Agent ID（子代理消息） */
  agentId?: string;
  /** 来源 Feature（如 'todo-feature'，仅 reminder 等） */
  source?: string;

  // === 分类标签 ===

  /** 消息分类标签（用于快速查询） */
  tags: MessageTag[];

  // === 解析结果 ===

  /** 从 content 中提取的结构化信息 */
  parsed: ParsedContent;
}

// ========== 生命周期类型 re-export ==========
// 生命周期类型从 lifecycle.ts 导出，保持类型定义集中管理
export type {
  AgentInitiateContext,
  AgentDestroyContext,
  CallStartContext,
  CallFinishContext,
  CallFinishReason,
  StepStartContext,
  StepFinishedContext,
  HookResult,
  ToolContext,
  ToolResult,
} from './lifecycle.js';

// ========== 决策上下文类型 ==========
/**
 * 决策上下文（反向钩子参数）
 *
 * 所有决策上下文的联合类型
 */
export type DecisionContext =
  | import('./lifecycle.js').AgentInitiateContext
  | import('./lifecycle.js').AgentDestroyContext
  | import('./lifecycle.js').CallStartContext
  | import('./lifecycle.js').CallFinishContext
  | import('./lifecycle.js').StepStartContext
  | import('./lifecycle.js').StepFinishedContext
  | import('./lifecycle.js').ToolContext
  | import('./lifecycle.js').ToolResult
  | import('./lifecycle.js').StepFinishDecisionContext
  | import('./lifecycle.js').ToolFinishedDecisionContext;

// ========== UDS 通信类型 ==========

/**
 * UDS 配置
 */
export interface UDSConfig {
  /** UDS 路径（默认自动检测平台） */
  path?: string;
  /** HTTP 端口（Web 界面） */
  httpPort?: number;
  /** 是否自动打开浏览器 */
  openBrowser?: boolean;
}

/**
 * 平台检测后的 UDS 路径
 */
export function getDefaultUDSPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\agentdev-viewer';
  }
  return '/tmp/agentdev-viewer.sock';
}
